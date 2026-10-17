// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VekilPolicy
/// @notice The owner's trading rules for the VEKİL agent, and the judge of every entry order (SPEC §13.1).
/// Every request is recorded: approvals and rejections alike. Critical violations pause the contract.
/// requestApproval never reverts for policy reasons; all of its arithmetic is done in uint256.
contract VekilPolicy {
    struct Policy {
        uint64 maxOrderQuote; // TRY ×1e8
        uint64 dailyRiskBudget; // TRY ×1e8
        uint16 maxTradesPerHour;
        uint16 maxTradesPerDay;
        uint16 minStopBps;
        uint16 maxStopBps;
        uint16 maxHoldMin;
        uint16 feeBps;
        uint16 slippageBps;
        uint64 validUntil; // unix seconds
    }

    struct OrderRequest {
        bytes32 instId;
        uint8 side;
        uint64 px;
        uint64 sz;
        uint64 stopPx;
        uint64 tpPx;
        uint32 timeStopMin;
        bytes32 decisionHash;
        bytes32 nonce;
    }

    struct Approval {
        uint8 status; // 0 none, 1 APPROVED, 2 REJECTED
        uint32 reasons;
        uint64 at;
        uint64 expiresAt;
        uint64 policyVersion;
        uint64 worstCase;
    }

    struct Anchor {
        bytes32 root;
        uint64 fromSeq;
        uint64 toSeq;
        uint64 at;
    }

    // reason bits (SPEC §9.4)
    uint32 internal constant R_PAUSED = 1 << 0;
    uint32 internal constant R_POLICY_EXPIRED = 1 << 1;
    uint32 internal constant R_INSTRUMENT_NOT_ALLOWED = 1 << 2;
    uint32 internal constant R_SIDE_NOT_ALLOWED = 1 << 3;
    uint32 internal constant R_ZERO_VALUE = 1 << 4;
    uint32 internal constant R_ORDER_TOO_LARGE = 1 << 5;
    uint32 internal constant R_STOP_MISSING = 1 << 6;
    uint32 internal constant R_STOP_INVALID = 1 << 7;
    uint32 internal constant R_STOP_TOO_TIGHT = 1 << 8;
    uint32 internal constant R_STOP_TOO_WIDE = 1 << 9;
    uint32 internal constant R_TP_INVALID = 1 << 10;
    uint32 internal constant R_TIME_STOP_INVALID = 1 << 11;
    uint32 internal constant R_HOURLY_LIMIT = 1 << 12;
    uint32 internal constant R_DAILY_LIMIT = 1 << 13;
    uint32 internal constant R_RISK_BUDGET_EXCEEDED = 1 << 14;

    uint8 internal constant SIDE_BUY = 1;
    uint8 internal constant STATUS_APPROVED = 1;
    uint8 internal constant STATUS_REJECTED = 2;
    uint256 internal constant SCALE = 1e8;
    uint256 internal constant TRT_OFFSET = 10800;
    uint256 internal constant MAX_INST_IDS = 8;
    uint256 internal constant MAX_INST_ID_BYTES = 20;
    uint256 internal constant MAX_STOP_BPS = 2000;

    address public immutable owner;
    address public immutable agent;
    uint64 public immutable hardMaxOrderQuote; // 1000 TL ×1e8
    uint64 public immutable hardMaxDailyRisk; // 500 TL ×1e8
    uint64 public constant APPROVAL_TTL = 120; // seconds
    uint32 public constant CRITICAL_MASK = (1 << 2) | (1 << 3) | (1 << 6);

    Policy public policy;
    uint64 public policyVersion;
    bytes32 public policyHash;
    bytes32 public sourceTextHash;
    string[] internal instIdStrings;
    mapping(bytes32 => bool) public instrumentAllowed;
    bool public paused;
    uint256 public agentId;

    mapping(bytes32 => Approval) public approvals;
    mapping(bytes15 => bytes32) public orderHashByPrefix; // approved entries (auditor)
    mapping(uint64 => uint16) public tradesInHour; // hourIndex = (ts + 10800) / 3600
    mapping(uint64 => uint16) public tradesInDay; // dayIndex  = (ts + 10800) / 86400
    mapping(uint64 => uint64) public riskUsedInDay; // TRY ×1e8
    mapping(bytes32 => uint64) public exitRecordedAt; // entry orderHash → ts
    mapping(bytes15 => bytes32) public entryByExitPrefix; // exit clOrdId prefix → entry orderHash
    mapping(uint64 => Anchor) public anchors;
    uint64 public anchorCount;
    uint64 public lastAnchoredSeq;

    event PolicySet(
        uint64 indexed version, bytes32 policyHash, bytes32 sourceTextHash, string sourceText, string[] instIds, Policy p
    );
    event Paused(address indexed by, uint32 reasons); // by = address(this) for auto-pause
    event Unpaused(address indexed by);
    event OrderApproved(bytes32 indexed orderHash, OrderRequest req, uint64 worstCase, uint64 policyVersion);
    event OrderRejected(bytes32 indexed orderHash, OrderRequest req, uint32 reasons, bool critical, uint64 policyVersion);
    event ExitRecorded(bytes32 indexed entryOrderHash, bytes15 exitPrefix, uint8 reason, int64 pnlQuote);
    event Anchored(uint64 indexed index, bytes32 root, uint64 fromSeq, uint64 toSeq);
    event AgentIdSet(uint256 agentId);

    error NotOwner();
    error NotAgent();
    error InvalidPolicy();
    error AlreadyRequested();
    error UnknownEntry();
    error ExitAlreadyRecorded();
    error BadAnchorRange();
    error BadExitReason();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(address agent_, uint64 hardMaxOrderQuote_, uint64 hardMaxDailyRisk_) {
        if (agent_ == address(0) || hardMaxOrderQuote_ == 0 || hardMaxDailyRisk_ == 0) revert InvalidPolicy();
        owner = msg.sender;
        agent = agent_;
        hardMaxOrderQuote = hardMaxOrderQuote_;
        hardMaxDailyRisk = hardMaxDailyRisk_;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Replace the policy. Reverts InvalidPolicy when invalid. Counters are kept; a pause is kept.
    function setPolicy(Policy calldata p, string[] calldata instIds, string calldata sourceText) external onlyOwner {
        _validate(p, instIds.length);
        bytes32[] memory hashes = _replaceAllowlist(instIds);
        bytes32 srcHash = keccak256(bytes(sourceText));
        policy = p;
        policyVersion += 1;
        policyHash = keccak256(abi.encode(p, hashes, srcHash));
        sourceTextHash = srcHash;
        _emitPolicySet(p, instIds, sourceText);
    }

    function _replaceAllowlist(string[] calldata instIds) internal returns (bytes32[] memory hashes) {
        uint256 oldLen = instIdStrings.length;
        for (uint256 i = 0; i < oldLen; i++) {
            delete instrumentAllowed[keccak256(bytes(instIdStrings[i]))];
        }
        delete instIdStrings;
        hashes = new bytes32[](instIds.length);
        for (uint256 i = 0; i < instIds.length; i++) {
            uint256 len = bytes(instIds[i]).length;
            if (len == 0 || len > MAX_INST_ID_BYTES) revert InvalidPolicy();
            bytes32 h = keccak256(bytes(instIds[i]));
            if (instrumentAllowed[h]) revert InvalidPolicy(); // duplicate (decision C1)
            instrumentAllowed[h] = true;
            instIdStrings.push(instIds[i]);
            hashes[i] = h;
        }
    }

    function _emitPolicySet(Policy calldata p, string[] calldata instIds, string calldata sourceText) internal {
        emit PolicySet(policyVersion, policyHash, sourceTextHash, sourceText, instIds, p);
    }

    function _validate(Policy calldata p, uint256 n) internal view {
        if (n == 0 || n > MAX_INST_IDS) revert InvalidPolicy();
        if (p.maxOrderQuote == 0 || p.maxOrderQuote > hardMaxOrderQuote) revert InvalidPolicy();
        if (p.dailyRiskBudget == 0 || p.dailyRiskBudget > hardMaxDailyRisk) revert InvalidPolicy();
        if (p.maxTradesPerHour == 0 || p.maxTradesPerHour > p.maxTradesPerDay) revert InvalidPolicy();
        if (p.minStopBps == 0 || p.minStopBps >= p.maxStopBps || p.maxStopBps > MAX_STOP_BPS) revert InvalidPolicy();
        if (p.maxHoldMin < 15 || p.maxHoldMin > 1440) revert InvalidPolicy();
        if (p.feeBps > 100 || p.slippageBps > 200) revert InvalidPolicy();
        if (p.validUntil <= block.timestamp) revert InvalidPolicy();
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender, 0);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setAgentId(uint256 id) external onlyOwner {
        agentId = id;
        emit AgentIdSet(id);
    }

    // ---------------------------------------------------------------- agent

    /// @notice Judge an entry order. Records APPROVED or REJECTED; never reverts for policy reasons.
    function requestApproval(OrderRequest calldata req) external onlyAgent returns (bytes32 orderHash, uint32 reasons) {
        orderHash = hashOrderFor(block.chainid, address(this), req);
        if (approvals[orderHash].status != 0) revert AlreadyRequested();

        Policy memory p = policy;
        uint256 ts = block.timestamp;
        uint64 h = uint64((ts + TRT_OFFSET) / 3600);
        uint64 d = uint64((ts + TRT_OFFSET) / 86400);

        uint256 px = req.px;
        uint256 sz = req.sz;
        uint256 stopPx = req.stopPx;
        uint256 notional = px * sz / SCALE;
        uint256 worstCase;

        if (paused) reasons |= R_PAUSED;
        if (ts > p.validUntil) reasons |= R_POLICY_EXPIRED;
        if (!instrumentAllowed[req.instId]) reasons |= R_INSTRUMENT_NOT_ALLOWED;
        if (req.side != SIDE_BUY) reasons |= R_SIDE_NOT_ALLOWED;
        if (px == 0 || sz == 0) reasons |= R_ZERO_VALUE;
        if (notional > p.maxOrderQuote) reasons |= R_ORDER_TOO_LARGE;
        if (stopPx == 0) {
            reasons |= R_STOP_MISSING;
        } else if (stopPx >= px) {
            reasons |= R_STOP_INVALID;
        } else {
            uint256 dist = (px - stopPx) * 10000 / px;
            if (dist < p.minStopBps) reasons |= R_STOP_TOO_TIGHT;
            if (dist > p.maxStopBps) reasons |= R_STOP_TOO_WIDE;
        }
        if (req.tpPx != 0 && req.tpPx <= px) reasons |= R_TP_INVALID;
        if (req.timeStopMin < 15 || req.timeStopMin > p.maxHoldMin) reasons |= R_TIME_STOP_INVALID;
        if (tradesInHour[h] >= p.maxTradesPerHour) reasons |= R_HOURLY_LIMIT;
        if (tradesInDay[d] >= p.maxTradesPerDay) reasons |= R_DAILY_LIMIT;
        if (stopPx != 0 && stopPx < px) {
            worstCase = (px - stopPx) * sz / SCALE
                + notional * (2 * uint256(p.feeBps) + uint256(p.slippageBps)) / 10000;
            if (uint256(riskUsedInDay[d]) + worstCase > p.dailyRiskBudget) reasons |= R_RISK_BUDGET_EXCEEDED;
        }

        uint64 version = policyVersion;
        if (reasons == 0) {
            // worstCase ≤ dailyRiskBudget ≤ hardMaxDailyRisk, so it fits in uint64.
            approvals[orderHash] = Approval({
                status: STATUS_APPROVED,
                reasons: 0,
                at: uint64(ts),
                expiresAt: uint64(ts) + APPROVAL_TTL,
                policyVersion: version,
                worstCase: uint64(worstCase)
            });
            // counts stay below maxTrades* (uint16), and risk below the budget (uint64)
            tradesInHour[h] += 1;
            tradesInDay[d] += 1;
            riskUsedInDay[d] += uint64(worstCase);
            orderHashByPrefix[bytes15(orderHash)] = orderHash;
            emit OrderApproved(orderHash, req, uint64(worstCase), version);
        } else {
            bool critical = (reasons & CRITICAL_MASK) != 0 || notional > 2 * uint256(p.maxOrderQuote);
            approvals[orderHash] = Approval({
                status: STATUS_REJECTED,
                reasons: reasons,
                at: uint64(ts),
                expiresAt: 0,
                policyVersion: version,
                worstCase: 0
            });
            emit OrderRejected(orderHash, req, reasons, critical, version);
            if (critical && !paused) {
                paused = true;
                emit Paused(address(this), reasons);
            }
        }
    }

    /// @notice Record an exit of an approved entry. Allowed while paused; exits never wait.
    function recordExit(bytes32 entryOrderHash, bytes15 exitPrefix, uint8 reason, int64 pnlQuote) external onlyAgent {
        if (approvals[entryOrderHash].status != STATUS_APPROVED) revert UnknownEntry();
        if (exitRecordedAt[entryOrderHash] != 0) revert ExitAlreadyRecorded();
        if (reason < 1 || reason > 6) revert BadExitReason();
        exitRecordedAt[entryOrderHash] = uint64(block.timestamp);
        entryByExitPrefix[exitPrefix] = entryOrderHash;
        emit ExitRecorded(entryOrderHash, exitPrefix, reason, pnlQuote);
    }

    /// @notice Anchor the Merkle root of ledger entries fromSeq..toSeq. Allowed while paused.
    function anchor(bytes32 root, uint64 fromSeq, uint64 toSeq) external onlyAgent {
        if (uint256(fromSeq) != uint256(lastAnchoredSeq) + 1 || toSeq < fromSeq) revert BadAnchorRange();
        uint64 index = anchorCount;
        anchors[index] = Anchor({root: root, fromSeq: fromSeq, toSeq: toSeq, at: uint64(block.timestamp)});
        anchorCount = index + 1;
        lastAnchoredSeq = toSeq;
        emit Anchored(index, root, fromSeq, toSeq);
    }

    // ---------------------------------------------------------------- views

    /// @notice Merkle inclusion of a ledger entry hash in anchor `index` (sorted pairs, SPEC §9.7).
    function verifyEntry(uint64 index, bytes32 entryHash, bytes32[] calldata proof) external view returns (bool) {
        if (index >= anchorCount) return false;
        bytes32 h = keccak256(abi.encodePacked(entryHash));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 s = proof[i];
            h = h <= s ? keccak256(abi.encodePacked(h, s)) : keccak256(abi.encodePacked(s, h));
        }
        return h == anchors[index].root;
    }

    function hashOrderFor(uint256 chainId, address policyAddr, OrderRequest calldata req) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, policyAddr, req));
    }

    function getPolicy()
        external
        view
        returns (Policy memory, string[] memory instIds, uint64 version, bool isPaused, bytes32 srcHash)
    {
        return (policy, instIdStrings, policyVersion, paused, sourceTextHash);
    }

    /// @notice Counters for the buckets that contain block.timestamp.
    function counters()
        external
        view
        returns (uint64 hourIndex, uint64 dayIndex, uint16 hourCount, uint16 dayCount, uint64 riskUsed)
    {
        hourIndex = uint64((block.timestamp + TRT_OFFSET) / 3600);
        dayIndex = uint64((block.timestamp + TRT_OFFSET) / 86400);
        hourCount = tradesInHour[hourIndex];
        dayCount = tradesInDay[dayIndex];
        riskUsed = riskUsedInDay[dayIndex];
    }
}
