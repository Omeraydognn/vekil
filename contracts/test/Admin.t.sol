// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VekilBase} from "./Base.t.sol";
import {VekilPolicy} from "../src/VekilPolicy.sol";

/// Access control, setPolicy validation, pause, agentId (SPEC §13.1, §23.4).
contract AdminTest is VekilBase {
    event PolicySet(
        uint64 indexed version, bytes32 policyHash, bytes32 sourceTextHash, string sourceText, string[] instIds, VekilPolicy.Policy p
    );
    event Paused(address indexed by, uint32 reasons);
    event Unpaused(address indexed by);
    event AgentIdSet(uint256 agentId);

    // ---------------------------------------------------------------- constructor

    function test_constructor() public view {
        assertEq(vp.owner(), OWNER);
        assertEq(vp.agent(), AGENT);
        assertEq(vp.hardMaxOrderQuote(), HARD_MAX_ORDER);
        assertEq(vp.hardMaxDailyRisk(), HARD_MAX_RISK);
        assertEq(vp.APPROVAL_TTL(), 120);
        assertEq(vp.CRITICAL_MASK(), (1 << 2) | (1 << 3) | (1 << 6));
    }

    function test_constructor_rejectsZeroAgentOrCaps() public {
        vm.expectRevert(VekilPolicy.InvalidPolicy.selector);
        new VekilPolicy(address(0), HARD_MAX_ORDER, HARD_MAX_RISK);
        vm.expectRevert(VekilPolicy.InvalidPolicy.selector);
        new VekilPolicy(AGENT, 0, HARD_MAX_RISK);
        vm.expectRevert(VekilPolicy.InvalidPolicy.selector);
        new VekilPolicy(AGENT, HARD_MAX_ORDER, 0);
    }

    function test_freshDeploy_rejectsEverythingAndPauses() public {
        vm.prank(OWNER);
        VekilPolicy fresh = new VekilPolicy(AGENT, HARD_MAX_ORDER, HARD_MAX_RISK);
        assertEq(fresh.policyVersion(), 0);
        vm.prank(AGENT);
        (, uint32 reasons) = fresh.requestApproval(vectorReq());
        assertTrue(reasons & R_POLICY_EXPIRED != 0);
        assertTrue(reasons & R_INSTRUMENT != 0);
        assertTrue(fresh.paused());
    }

    // ---------------------------------------------------------------- access control

    function test_onlyOwner() public {
        VekilPolicy.Policy memory p = defaultPolicy();
        string[] memory ids = _avax();
        address[2] memory notOwners = [AGENT, STRANGER];
        for (uint256 i = 0; i < 2; i++) {
            vm.startPrank(notOwners[i]);
            vm.expectRevert(VekilPolicy.NotOwner.selector);
            vp.setPolicy(p, ids, "");
            vm.expectRevert(VekilPolicy.NotOwner.selector);
            vp.pause();
            vm.expectRevert(VekilPolicy.NotOwner.selector);
            vp.unpause();
            vm.expectRevert(VekilPolicy.NotOwner.selector);
            vp.setAgentId(7);
            vm.stopPrank();
        }
    }

    function test_onlyAgent() public {
        address[2] memory notAgents = [OWNER, STRANGER];
        for (uint256 i = 0; i < 2; i++) {
            vm.startPrank(notAgents[i]);
            vm.expectRevert(VekilPolicy.NotAgent.selector);
            vp.requestApproval(vectorReq());
            vm.expectRevert(VekilPolicy.NotAgent.selector);
            vp.recordExit(bytes32(0), bytes15(0), 1, 0);
            vm.expectRevert(VekilPolicy.NotAgent.selector);
            vp.anchor(bytes32(uint256(1)), 1, 1);
            vm.stopPrank();
        }
    }

    // ---------------------------------------------------------------- setPolicy happy path

    function test_setPolicy_storesAndEmits() public {
        VekilPolicy.Policy memory p = roomyPolicy();
        string[] memory ids = new string[](2);
        ids[0] = "BTC-TRY";
        ids[1] = "AVAX-TRY";
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = BTC_TRY;
        hashes[1] = AVAX_TRY;
        string memory text = unicode"Kurallar: günde 10 işlem";
        bytes32 srcHash = keccak256(bytes(text));
        bytes32 expectedHash = keccak256(abi.encode(p, hashes, srcHash));
        vm.expectEmit(true, false, false, true, address(vp));
        emit PolicySet(2, expectedHash, srcHash, text, ids, p);
        _setPolicy(p, ids, text);

        assertEq(vp.policyVersion(), 2);
        assertEq(vp.policyHash(), expectedHash);
        assertEq(vp.sourceTextHash(), srcHash);
        assertTrue(vp.instrumentAllowed(BTC_TRY));
        assertTrue(vp.instrumentAllowed(AVAX_TRY));
        (VekilPolicy.Policy memory got, string[] memory gotIds, uint64 version, bool isPaused, bytes32 gotSrc) = vp.getPolicy();
        assertEq(abi.encode(got), abi.encode(p));
        assertEq(gotIds.length, 2);
        assertEq(gotIds[0], "BTC-TRY");
        assertEq(gotIds[1], "AVAX-TRY");
        assertEq(version, 2);
        assertFalse(isPaused);
        assertEq(gotSrc, srcHash);
    }

    function test_setPolicy_clearsOldAllowlist() public {
        string[] memory ids = new string[](1);
        ids[0] = "BTC-TRY";
        _setPolicy(defaultPolicy(), ids, "");
        assertFalse(vp.instrumentAllowed(AVAX_TRY));
        assertTrue(vp.instrumentAllowed(BTC_TRY));
        (, uint32 reasons) = _request(validReq());
        assertEq(reasons, R_INSTRUMENT);
    }

    function test_setPolicy_doesNotUnpause() public {
        vm.prank(OWNER);
        vp.pause();
        _setPolicy(defaultPolicy(), _avax(), "");
        assertTrue(vp.paused());
    }

    function test_setPolicy_doesNotResetCounters() public {
        _request(validReq());
        uint64 d = _dayIndex(block.timestamp);
        uint64 h = _hourIndex(block.timestamp);
        _setPolicy(defaultPolicy(), _avax(), "");
        assertEq(vp.tradesInHour(h), 1);
        assertEq(vp.tradesInDay(d), 1);
        assertEq(vp.riskUsedInDay(d), 378523321);
        (, uint32 reasons) = _request(validReq());
        assertEq(reasons, R_HOURLY);
    }

    function test_loweringLimits_doesNotResetCounters() public {
        _setPolicy(roomyPolicy(), _avax(), "");
        _request(validReq());
        _request(validReq());
        VekilPolicy.Policy memory p = roomyPolicy();
        p.maxTradesPerHour = 2;
        p.maxTradesPerDay = 2;
        p.dailyRiskBudget = 1e8;
        _setPolicy(p, _avax(), "");
        (,, uint16 hourCount, uint16 dayCount, uint64 riskUsed) = vp.counters();
        assertEq(hourCount, 2);
        assertEq(dayCount, 2);
        assertEq(riskUsed, 2 * 378523321);
        (, uint32 reasons) = _request(validReq());
        assertEq(reasons, R_HOURLY | R_DAILY | R_RISK);
    }

    function test_setPolicy_boundariesAccepted() public {
        VekilPolicy.Policy memory p = defaultPolicy();
        p.maxOrderQuote = HARD_MAX_ORDER;
        p.dailyRiskBudget = HARD_MAX_RISK;
        p.maxTradesPerHour = 1;
        p.maxTradesPerDay = 1;
        p.minStopBps = 1;
        p.maxStopBps = 2000;
        p.maxHoldMin = 15;
        p.feeBps = 100;
        p.slippageBps = 200;
        p.validUntil = uint64(block.timestamp) + 1;
        string[] memory ids = new string[](8);
        for (uint256 i = 0; i < 8; i++) ids[i] = string(abi.encodePacked("X", vm.toString(i), "-TRY"));
        _setPolicy(p, ids, "");
        p.maxHoldMin = 1440;
        string[] memory one = new string[](1);
        one[0] = "ABCDEFGHIJ-KLMNOPQR"; // 19 bytes
        _setPolicy(p, one, "");
        one[0] = "ABCDEFGHIJ-KLMNOPQRS"; // 20 bytes
        _setPolicy(p, one, "");
        one[0] = "A"; // 1 byte
        _setPolicy(p, one, "");
    }

    // ---------------------------------------------------------------- setPolicy validation (every branch)

    function _expectInvalid(VekilPolicy.Policy memory p, string[] memory ids) internal {
        vm.prank(OWNER);
        vm.expectRevert(VekilPolicy.InvalidPolicy.selector);
        vp.setPolicy(p, ids, "");
    }

    function test_invalid_noInstIds() public {
        _expectInvalid(defaultPolicy(), new string[](0));
    }

    function test_invalid_nineInstIds() public {
        string[] memory ids = new string[](9);
        for (uint256 i = 0; i < 9; i++) ids[i] = string(abi.encodePacked("X", vm.toString(i), "-TRY"));
        _expectInvalid(defaultPolicy(), ids);
    }

    function test_invalid_emptyInstId() public {
        string[] memory ids = new string[](1);
        ids[0] = "";
        _expectInvalid(defaultPolicy(), ids);
    }

    function test_invalid_instIdTooLong() public {
        string[] memory ids = new string[](1);
        ids[0] = "ABCDEFGHIJ-KLMNOPQRST"; // 21 bytes
        _expectInvalid(defaultPolicy(), ids);
    }

    function test_invalid_duplicateInstId() public {
        string[] memory ids = new string[](2);
        ids[0] = "AVAX-TRY";
        ids[1] = "AVAX-TRY";
        _expectInvalid(defaultPolicy(), ids);
    }

    function test_invalid_maxOrderQuote() public {
        VekilPolicy.Policy memory p = defaultPolicy();
        p.maxOrderQuote = 0;
        _expectInvalid(p, _avax());
        p.maxOrderQuote = HARD_MAX_ORDER + 1;
        _expectInvalid(p, _avax());
    }

    function test_invalid_dailyRiskBudget() public {
        VekilPolicy.Policy memory p = defaultPolicy();
        p.dailyRiskBudget = 0;
        _expectInvalid(p, _avax());
        p.dailyRiskBudget = HARD_MAX_RISK + 1;
        _expectInvalid(p, _avax());
    }

    function test_invalid_trades() public {
        VekilPolicy.Policy memory p = defaultPolicy();
        p.maxTradesPerHour = 0;
        p.maxTradesPerDay = 0;
        _expectInvalid(p, _avax());
        p.maxTradesPerHour = 5;
        p.maxTradesPerDay = 4;
        _expectInvalid(p, _avax());
    }

    function test_invalid_stopBps() public {
        VekilPolicy.Policy memory p = defaultPolicy();
        p.minStopBps = 0;
        _expectInvalid(p, _avax());
        p.minStopBps = 300;
        p.maxStopBps = 300;
        _expectInvalid(p, _avax());
        p.minStopBps = 30;
        p.maxStopBps = 2001;
        _expectInvalid(p, _avax());
    }

    function test_invalid_maxHoldMin() public {
        VekilPolicy.Policy memory p = defaultPolicy();
        p.maxHoldMin = 14;
        _expectInvalid(p, _avax());
        p.maxHoldMin = 1441;
        _expectInvalid(p, _avax());
    }

    function test_invalid_feeAndSlippage() public {
        VekilPolicy.Policy memory p = defaultPolicy();
        p.feeBps = 101;
        _expectInvalid(p, _avax());
        p.feeBps = 20;
        p.slippageBps = 201;
        _expectInvalid(p, _avax());
    }

    function test_invalid_validUntil() public {
        VekilPolicy.Policy memory p = defaultPolicy();
        p.validUntil = uint64(block.timestamp);
        _expectInvalid(p, _avax());
        p.validUntil = uint64(block.timestamp) - 1;
        _expectInvalid(p, _avax());
    }

    // ---------------------------------------------------------------- pause / unpause / agentId

    function test_pauseUnpause_events() public {
        vm.expectEmit(true, false, false, true, address(vp));
        emit Paused(OWNER, 0);
        vm.prank(OWNER);
        vp.pause();
        assertTrue(vp.paused());
        vm.expectEmit(true, false, false, true, address(vp));
        emit Unpaused(OWNER);
        vm.prank(OWNER);
        vp.unpause();
        assertFalse(vp.paused());
    }

    function test_pause_idempotent() public {
        vm.startPrank(OWNER);
        vp.pause();
        vp.pause();
        assertTrue(vp.paused());
        vp.unpause();
        vp.unpause();
        assertFalse(vp.paused());
        vm.stopPrank();
    }

    function test_setAgentId() public {
        vm.expectEmit(false, false, false, true, address(vp));
        emit AgentIdSet(42);
        vm.prank(OWNER);
        vp.setAgentId(42);
        assertEq(vp.agentId(), 42);
    }
}
