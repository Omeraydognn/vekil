// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VekilBase} from "./Base.t.sol";
import {VekilPolicy} from "../src/VekilPolicy.sol";

/// Every reason bit: a failing and a passing case (SPEC §13.1, §23.4).
contract ReasonsTest is VekilBase {
    event Paused(address indexed by, uint32 reasons);
    event OrderApproved(bytes32 indexed orderHash, VekilPolicy.OrderRequest req, uint64 worstCase, uint64 policyVersion);
    event OrderRejected(
        bytes32 indexed orderHash, VekilPolicy.OrderRequest req, uint32 reasons, bool critical, uint64 policyVersion
    );

    function _expectOnly(VekilPolicy.OrderRequest memory r, uint32 mask, bool shouldPause) internal {
        (bytes32 h, uint32 reasons) = _request(r);
        assertEq(reasons, mask, "mask");
        assertEq(_status(h), mask == 0 ? 1 : 2, "status");
        assertEq(_reasons(h), mask, "stored mask");
        assertEq(vp.paused(), shouldPause, "paused");
    }

    // ---------------------------------------------------------------- pass

    function test_vectorRequestApproved() public {
        VekilPolicy.OrderRequest memory r = vectorReq();
        bytes32 h = vp.hashOrderFor(block.chainid, address(vp), r);
        // worstCase = 590000000 * 40428000 / 1e8 + 19999731600 * 70 / 10000 = 238525200 + 139998121
        vm.expectEmit(true, false, false, true, address(vp));
        emit OrderApproved(h, r, 378523321, 1);
        (bytes32 got, uint32 reasons) = _request(r);
        assertEq(got, h);
        assertEq(reasons, 0);
        (uint8 status, uint32 rs, uint64 at, uint64 expiresAt, uint64 version, uint64 worstCase) = vp.approvals(h);
        assertEq(status, 1);
        assertEq(rs, 0);
        assertEq(at, T0);
        assertEq(expiresAt, T0 + 120);
        assertEq(version, 1);
        assertEq(worstCase, 378523321);
        assertEq(vp.orderHashByPrefix(bytes15(h)), h);
    }

    // ---------------------------------------------------------------- bit 0 PAUSED

    function test_bit0_paused() public {
        vm.prank(OWNER);
        vp.pause();
        _expectOnly(validReq(), R_PAUSED, true);
    }

    function test_bit0_pass_afterUnpause() public {
        vm.prank(OWNER);
        vp.pause();
        vm.prank(OWNER);
        vp.unpause();
        _expectOnly(validReq(), 0, false);
    }

    // ---------------------------------------------------------------- bit 1 POLICY_EXPIRED

    function test_bit1_expired() public {
        vm.warp(VECTOR_VALID_UNTIL + 1);
        _expectOnly(validReq(), R_POLICY_EXPIRED, false);
    }

    function test_bit1_pass_atValidUntil() public {
        vm.warp(VECTOR_VALID_UNTIL);
        _expectOnly(validReq(), 0, false);
    }

    // ---------------------------------------------------------------- bit 2 INSTRUMENT_NOT_ALLOWED (critical)

    function test_bit2_instrument_critical() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.instId = BTC_TRY;
        bytes32 h = vp.hashOrderFor(block.chainid, address(vp), r);
        vm.expectEmit(true, false, false, true, address(vp));
        emit OrderRejected(h, r, R_INSTRUMENT, true, 1);
        vm.expectEmit(true, false, false, true, address(vp));
        emit Paused(address(vp), R_INSTRUMENT);
        _expectOnly(r, R_INSTRUMENT, true);
    }

    function test_bit2_pass_secondInstrument() public {
        string[] memory ids = new string[](2);
        ids[0] = "AVAX-TRY";
        ids[1] = "BTC-TRY";
        _setPolicy(defaultPolicy(), ids, "");
        VekilPolicy.OrderRequest memory r = validReq();
        r.instId = BTC_TRY;
        _expectOnly(r, 0, false);
    }

    // ---------------------------------------------------------------- bit 3 SIDE_NOT_ALLOWED (critical)

    function test_bit3_side2_critical() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.side = 2;
        _expectOnly(r, R_SIDE, true);
    }

    function test_bit3_side0_critical() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.side = 0;
        _expectOnly(r, R_SIDE, true);
    }

    // ---------------------------------------------------------------- bit 4 ZERO_VALUE (not critical)

    function test_bit4_zeroSize_notCritical() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.sz = 0;
        _expectOnly(r, R_ZERO, false);
    }

    function test_bit4_zeroPrice_alsoStopInvalid() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.px = 0;
        _expectOnly(r, R_ZERO | R_STOP_INVALID, false); // tp 506.6 > 0, so TP is fine
    }

    // ---------------------------------------------------------------- bit 5 ORDER_TOO_LARGE (critical above 2×)

    function test_bit5_tooLarge_notCritical() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.sz = 60000000; // 0.6 × 494.7 = 296.82 TL
        _expectOnly(r, R_TOO_LARGE, false);
    }

    function test_bit5_exactlyTwiceMax_notCritical() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.px = 500e8;
        r.sz = 80000000; // 400 TL = 2 × 200
        r.stopPx = 495e8;
        r.tpPx = 510e8;
        _expectOnly(r, R_TOO_LARGE, false);
    }

    function test_bit5_aboveTwiceMax_critical() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.px = 500e8;
        r.sz = 80000001; // 400.000005 TL
        r.stopPx = 495e8;
        r.tpPx = 510e8;
        vm.expectEmit(true, false, false, true, address(vp));
        emit Paused(address(vp), R_TOO_LARGE);
        _expectOnly(r, R_TOO_LARGE, true);
    }

    function test_bit5_pass_exactlyMax() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.px = 500e8;
        r.sz = 40000000; // 200 TL
        r.stopPx = 495e8;
        r.tpPx = 510e8;
        _expectOnly(r, 0, false);
    }

    // ---------------------------------------------------------------- bit 6 STOP_MISSING (critical)

    function test_bit6_stopMissing_critical() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.stopPx = 0;
        _expectOnly(r, R_STOP_MISSING, true);
    }

    // ---------------------------------------------------------------- bit 7 STOP_INVALID

    function test_bit7_stopEqualsPx() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.stopPx = r.px;
        _expectOnly(r, R_STOP_INVALID, false);
    }

    function test_bit7_stopAbovePx() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.stopPx = r.px + 1;
        _expectOnly(r, R_STOP_INVALID, false);
    }

    // ---------------------------------------------------------------- bits 8/9 STOP_TOO_TIGHT / STOP_TOO_WIDE

    function test_bit8_stopTooTight() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.stopPx = 49400000000; // 14 bps
        _expectOnly(r, R_STOP_TIGHT, false);
    }

    function test_bit8_pass_exactlyMin() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.px = 500e8;
        r.sz = 40000000;
        r.stopPx = 4985e7; // 30 bps exactly
        r.tpPx = 510e8;
        _expectOnly(r, 0, false);
    }

    function test_bit9_stopTooWide() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.stopPx = 47000000000; // 499 bps
        _expectOnly(r, R_STOP_WIDE, false);
    }

    function test_bit9_pass_exactlyMax() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.px = 500e8;
        r.sz = 40000000;
        r.stopPx = 485e8; // 300 bps exactly
        r.tpPx = 510e8;
        _expectOnly(r, 0, false);
    }

    // ---------------------------------------------------------------- bit 10 TP_INVALID

    function test_bit10_tpEqualsPx() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.tpPx = r.px;
        _expectOnly(r, R_TP_INVALID, false);
    }

    function test_bit10_tpBelowPx() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.tpPx = r.px - 1;
        _expectOnly(r, R_TP_INVALID, false);
    }

    function test_bit10_pass_noTp() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.tpPx = 0;
        _expectOnly(r, 0, false);
    }

    // ---------------------------------------------------------------- bit 11 TIME_STOP_INVALID

    function test_bit11_timeStopTooShort() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.timeStopMin = 14;
        _expectOnly(r, R_TIME_STOP, false);
    }

    function test_bit11_timeStopAboveMaxHold() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.timeStopMin = 481;
        _expectOnly(r, R_TIME_STOP, false);
    }

    function test_bit11_pass_bounds() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.timeStopMin = 15;
        _expectOnly(r, 0, false);
        vm.warp(block.timestamp + 1 hours);
        r = validReq();
        r.timeStopMin = 480;
        _expectOnly(r, 0, false);
    }

    // ---------------------------------------------------------------- bit 12 HOURLY_LIMIT

    function test_bit12_hourly() public {
        _expectOnly(validReq(), 0, false);
        _expectOnly(validReq(), R_HOURLY, false);
        vm.warp(T0 + 1 hours);
        _expectOnly(validReq(), 0, false);
    }

    // ---------------------------------------------------------------- bit 13 DAILY_LIMIT

    function test_bit13_daily() public {
        // default: 1/h, 4/day; T0 is 09:00 TRT.
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(T0 + i * 1 hours);
            _expectOnly(validReq(), 0, false);
        }
        vm.warp(T0 + 4 hours);
        _expectOnly(validReq(), R_DAILY, false);
    }

    function test_bit12_bit13_together() public {
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(T0 + i * 1 hours);
            _request(validReq());
        }
        _expectOnly(validReq(), R_HOURLY | R_DAILY, false);
    }

    // ---------------------------------------------------------------- bit 14 RISK_BUDGET_EXCEEDED

    function test_bit14_riskBudget() public {
        VekilPolicy.Policy memory p = roomyPolicy();
        p.dailyRiskBudget = 5e8; // one vector order uses 3.78523321 TL
        _setPolicy(p, _avax(), "");
        _expectOnly(validReq(), 0, false);
        _expectOnly(validReq(), R_RISK, false);
        assertEq(vp.riskUsedInDay(_dayIndex(block.timestamp)), 378523321);
    }

    function test_bit14_pass_exactlyBudget() public {
        VekilPolicy.Policy memory p = roomyPolicy();
        p.dailyRiskBudget = 378523321;
        _setPolicy(p, _avax(), "");
        _expectOnly(validReq(), 0, false);
        _expectOnly(validReq(), R_RISK, false);
    }

    function test_bit14_notCheckedWithoutValidStop() public {
        VekilPolicy.Policy memory p = roomyPolicy();
        p.dailyRiskBudget = 1;
        _setPolicy(p, _avax(), "");
        VekilPolicy.OrderRequest memory r = validReq();
        r.stopPx = r.px; // STOP_INVALID, no worst case
        _expectOnly(r, R_STOP_INVALID, false);
    }

    // ---------------------------------------------------------------- critical behaviour

    function test_R1_threeReasons_critical() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.instId = DOGE_TRY;
        r.px = 700700000;
        r.sz = 142714428000;
        r.stopPx = 0;
        r.tpPx = 0;
        _expectOnly(r, R_INSTRUMENT | R_TOO_LARGE | R_STOP_MISSING, true);
    }

    function test_criticalWhilePaused_noSecondPauseEvent() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.stopPx = 0;
        _request(r);
        assertTrue(vp.paused());
        r = validReq();
        r.stopPx = 0;
        vm.recordLogs();
        (, uint32 reasons) = _request(r);
        assertEq(reasons, R_PAUSED | R_STOP_MISSING);
        assertEq(vm.getRecordedLogs().length, 1, "only OrderRejected");
    }

    function test_afterAutoPause_validGetsPausedBit() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.side = 2;
        _request(r);
        _expectOnly(validReq(), R_PAUSED, true);
    }

    function test_rejectionDoesNotTouchCounters() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.tpPx = 1;
        _request(r);
        (,, uint16 hourCount, uint16 dayCount, uint64 riskUsed) = vp.counters();
        assertEq(hourCount, 0);
        assertEq(dayCount, 0);
        assertEq(riskUsed, 0);
        assertEq(vp.orderHashByPrefix(bytes15(vp.hashOrderFor(block.chainid, address(vp), r))), bytes32(0));
        (,,,,, uint64 worstCase) = vp.approvals(vp.hashOrderFor(block.chainid, address(vp), r));
        assertEq(worstCase, 0);
    }

    // ---------------------------------------------------------------- overflow (SPEC §23.4)

    function test_overflow_r1Sized_recordedNoRevert() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.instId = DOGE_TRY;
        r.px = 700700000;
        r.sz = 142714428000; // px × sz overflows uint64 (≈ 1e20)
        r.stopPx = 0;
        r.tpPx = 0;
        r.timeStopMin = 480;
        (bytes32 h, uint32 reasons) = _request(r);
        assertEq(_status(h), 2);
        assertTrue(reasons & R_TOO_LARGE != 0);
    }

    function test_overflow_r1Sized_withAllowedInstrumentAndStop() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.px = 700700000;
        r.sz = 142714428000;
        r.stopPx = 690000000;
        r.tpPx = 0;
        (bytes32 h, uint32 reasons) = _request(r);
        assertEq(_status(h), 2);
        assertEq(reasons, R_TOO_LARGE | R_RISK); // ≈ 10,000 TL, worst case far above budget
        assertTrue(vp.paused()); // > 2 × max
    }

    function test_overflow_uint64Max_everywhere() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.px = type(uint64).max;
        r.sz = type(uint64).max;
        r.stopPx = 1;
        r.tpPx = type(uint64).max;
        r.timeStopMin = type(uint32).max;
        (bytes32 h, uint32 reasons) = _request(r);
        assertEq(_status(h), 2);
        assertEq(reasons, R_TOO_LARGE | R_STOP_WIDE | R_TP_INVALID | R_TIME_STOP | R_RISK);
    }

    // ---------------------------------------------------------------- AlreadyRequested

    function test_alreadyRequested_approved() public {
        VekilPolicy.OrderRequest memory r = validReq();
        _request(r);
        vm.prank(AGENT);
        vm.expectRevert(VekilPolicy.AlreadyRequested.selector);
        vp.requestApproval(r);
    }

    function test_alreadyRequested_rejected() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.tpPx = 1;
        _request(r);
        vm.prank(AGENT);
        vm.expectRevert(VekilPolicy.AlreadyRequested.selector);
        vp.requestApproval(r);
    }
}
