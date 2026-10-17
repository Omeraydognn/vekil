// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {VekilBase} from "./Base.t.sol";
import {VekilPolicy} from "../src/VekilPolicy.sol";

contract FuzzTest is VekilBase {
    /// requestApproval never reverts over the full uint64/uint32/uint8 ranges (SPEC §23.4).
    function testFuzz_requestApproval_neverReverts(
        bytes32 instId,
        uint8 side,
        uint64 px,
        uint64 sz,
        uint64 stopPx,
        uint64 tpPx,
        uint32 timeStopMin,
        bytes32 nonce,
        uint32 warpBy,
        bool pausedFirst
    ) public {
        if (pausedFirst) {
            vm.prank(OWNER);
            vp.pause();
        }
        vm.warp(uint256(T0) + warpBy);
        VekilPolicy.OrderRequest memory r = VekilPolicy.OrderRequest({
            instId: instId,
            side: side,
            px: px,
            sz: sz,
            stopPx: stopPx,
            tpPx: tpPx,
            timeStopMin: timeStopMin,
            decisionHash: keccak256("d"),
            nonce: nonce
        });
        vm.prank(AGENT);
        (bytes32 h, uint32 reasons) = vp.requestApproval(r);
        assertEq(h, vp.hashOrderFor(block.chainid, address(vp), r));
        assertEq(_status(h), reasons == 0 ? 1 : 2);
        assertLt(reasons, uint32(1) << 15);
    }

    /// Mostly plausible values so approvals actually happen; checks every approval's guarantees.
    function testFuzz_approvedImpliesPolicy(uint64 px, uint64 sz, uint64 stopPx, uint64 tpPx, uint32 timeStopMin) public {
        _setPolicy(roomyPolicy(), _avax(), "");
        px = uint64(bound(px, 1, 1000e8));
        sz = uint64(bound(sz, 1, 10e8));
        stopPx = uint64(bound(stopPx, 0, uint256(px) + 1));
        tpPx = uint64(bound(tpPx, 0, uint256(px) * 2));
        timeStopMin = uint32(bound(timeStopMin, 0, 2000));
        VekilPolicy.OrderRequest memory r = validReq();
        (r.px, r.sz, r.stopPx, r.tpPx, r.timeStopMin) = (px, sz, stopPx, tpPx, timeStopMin);
        (bytes32 h, uint32 reasons) = _request(r);
        if (reasons != 0) return;
        VekilPolicy.Policy memory p = roomyPolicy();
        uint256 notional = uint256(px) * sz / 1e8;
        assertLe(notional, p.maxOrderQuote);
        assertGt(px, 0);
        assertGt(sz, 0);
        assertGt(stopPx, 0);
        assertLt(stopPx, px);
        uint256 dist = (uint256(px) - stopPx) * 10000 / px;
        assertGe(dist, p.minStopBps);
        assertLe(dist, p.maxStopBps);
        assertTrue(tpPx == 0 || tpPx > px);
        assertGe(timeStopMin, 15);
        assertLe(timeStopMin, p.maxHoldMin);
        (,,,,, uint64 worstCase) = vp.approvals(h);
        assertLe(worstCase, p.dailyRiskBudget);
        assertEq(vp.orderHashByPrefix(bytes15(h)), h);
    }
}

/// Drives the agent-side functions under a policy fixed in setUp.
contract Handler is Test {
    VekilPolicy internal vp;
    address internal agent;
    bytes32 internal instId;
    uint256 internal nonce;

    bytes32[] public approved;
    uint64[] public touchedHours;
    uint64[] public touchedDays;
    uint64 public nextSeq = 1;

    constructor(VekilPolicy vp_, address agent_, bytes32 instId_) {
        vp = vp_;
        agent = agent_;
        instId = instId_;
    }

    function request(uint64 px, uint64 sz, uint64 stopPx, uint64 tpPx, uint32 timeStopMin) external {
        px = uint64(bound(px, 1e8, 1000e8));
        sz = uint64(bound(sz, 1, uint256(200e8) * 1e8 / px)); // notional ≤ 200 TL, never critical
        stopPx = uint64(bound(stopPx, 1, px - 1));
        tpPx = uint64(bound(tpPx, 0, uint256(px) * 2));
        timeStopMin = uint32(bound(timeStopMin, 0, 600));
        VekilPolicy.OrderRequest memory r = VekilPolicy.OrderRequest({
            instId: instId,
            side: 1,
            px: px,
            sz: sz,
            stopPx: stopPx,
            tpPx: tpPx,
            timeStopMin: timeStopMin,
            decisionHash: keccak256("d"),
            nonce: keccak256(abi.encode(++nonce))
        });
        vm.prank(agent);
        (bytes32 h, uint32 reasons) = vp.requestApproval(r);
        touchedHours.push(uint64((block.timestamp + 10800) / 3600));
        touchedDays.push(uint64((block.timestamp + 10800) / 86400));
        if (reasons == 0) approved.push(h);
    }

    function recordExit(uint256 i, uint8 reason, int64 pnl) external {
        if (approved.length == 0) return;
        bytes32 h = approved[i % approved.length];
        if (vp.exitRecordedAt(h) != 0) return;
        vm.prank(agent);
        vp.recordExit(h, bytes15(keccak256(abi.encode(h))), uint8(bound(reason, 1, 6)), pnl);
    }

    function anchor(bytes32 root, uint64 len) external {
        uint64 toSeq = nextSeq + uint64(bound(len, 0, 20));
        vm.prank(agent);
        vp.anchor(root, nextSeq, toSeq);
        nextSeq = toSeq + 1;
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
    }

    function touchedCount() external view returns (uint256) {
        return touchedHours.length;
    }
}

contract InvariantTest is StdInvariant, VekilBase {
    Handler internal handler;
    VekilPolicy.Policy internal p;

    function setUp() public override {
        super.setUp();
        p = roomyPolicy();
        p.maxTradesPerHour = 3;
        p.maxTradesPerDay = 6;
        p.dailyRiskBudget = 20e8;
        _setPolicy(p, _avax(), "");
        handler = new Handler(vp, AGENT, AVAX_TRY);
        targetContract(address(handler));
    }

    function invariant_bucketsWithinLimits() public view {
        uint256 n = handler.touchedCount();
        for (uint256 i = 0; i < n; i++) {
            uint64 h = handler.touchedHours(i);
            uint64 d = handler.touchedDays(i);
            assertLe(vp.tradesInHour(h), p.maxTradesPerHour);
            assertLe(vp.tradesInDay(d), p.maxTradesPerDay);
            assertLe(vp.riskUsedInDay(d), p.dailyRiskBudget);
        }
        assertFalse(vp.paused());
        assertEq(vp.lastAnchoredSeq(), handler.nextSeq() - 1);
    }
}
