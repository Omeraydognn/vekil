// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VekilBase} from "./Base.t.sol";
import {VekilPolicy} from "../src/VekilPolicy.sol";

/// Counters and buckets, exits, anchors and the frozen TS vectors (SPEC §13.1, §23.4).
contract CountersTest is VekilBase {
    function setUp() public override {
        super.setUp();
        _setPolicy(roomyPolicy(), _avax(), "");
    }

    function test_counters_atBlockTimestamp() public {
        _request(validReq());
        _request(validReq());
        (uint64 hourIndex, uint64 dayIndex, uint16 hourCount, uint16 dayCount, uint64 riskUsed) = vp.counters();
        assertEq(hourIndex, _hourIndex(T0));
        assertEq(dayIndex, _dayIndex(T0));
        assertEq(hourCount, 2);
        assertEq(dayCount, 2);
        assertEq(riskUsed, 2 * 378523321);
        vm.warp(T0 + 1 hours);
        (hourIndex,, hourCount, dayCount,) = vp.counters();
        assertEq(hourIndex, _hourIndex(T0) + 1);
        assertEq(hourCount, 0);
        assertEq(dayCount, 2);
    }

    function test_buckets_trtHourBoundary() public {
        vm.warp(T0 + 1 hours - 1); // 09:59:59 TRT
        _request(validReq());
        assertEq(vp.tradesInHour(_hourIndex(block.timestamp)), 1);
        vm.warp(T0 + 1 hours); // 10:00:00 TRT
        (,, uint16 hourCount,,) = vp.counters();
        assertEq(hourCount, 0);
    }

    function test_buckets_trtDayBoundary() public {
        // TRT midnight = 21:00:00Z. T0 + 15 h = 2026-10-18 00:00:00 TRT.
        uint256 midnight = T0 + 15 hours;
        assertEq((midnight + 10800) % 86400, 0);
        vm.warp(midnight - 1);
        _request(validReq());
        (, uint64 day1,, uint16 dayCount1, uint64 risk1) = vp.counters();
        assertEq(dayCount1, 1);
        assertEq(risk1, 378523321);
        vm.warp(midnight);
        (, uint64 day2,, uint16 dayCount2, uint64 risk2) = vp.counters();
        assertEq(day2, day1 + 1);
        assertEq(dayCount2, 0);
        assertEq(risk2, 0);
        _request(validReq());
        assertEq(vp.tradesInDay(day2), 1);
        assertEq(vp.tradesInDay(day1), 1);
    }

    function test_dailyLimit_resetsNextTrtDay() public {
        VekilPolicy.Policy memory p = roomyPolicy();
        p.maxTradesPerHour = 2;
        p.maxTradesPerDay = 2;
        _setPolicy(p, _avax(), "");
        _request(validReq());
        _request(validReq());
        (, uint32 reasons) = _request(validReq());
        assertEq(reasons, R_HOURLY | R_DAILY);
        vm.warp(T0 + 15 hours); // next TRT day
        (, reasons) = _request(validReq());
        assertEq(reasons, 0);
    }

    function test_riskBudget_resetsNextTrtDay() public {
        VekilPolicy.Policy memory p = roomyPolicy();
        p.dailyRiskBudget = 5e8;
        _setPolicy(p, _avax(), "");
        _request(validReq());
        (, uint32 reasons) = _request(validReq());
        assertEq(reasons, R_RISK);
        vm.warp(T0 + 15 hours);
        (, reasons) = _request(validReq());
        assertEq(reasons, 0);
    }

    function test_ttl() public {
        (bytes32 h,) = _request(validReq());
        (, , uint64 at, uint64 expiresAt,,) = vp.approvals(h);
        assertEq(at, T0);
        assertEq(expiresAt, T0 + vp.APPROVAL_TTL());
    }

    function test_orderHashByPrefix() public {
        (bytes32 h,) = _request(validReq());
        assertEq(vp.orderHashByPrefix(bytes15(h)), h);
        assertEq(vp.orderHashByPrefix(bytes15(keccak256("other"))), bytes32(0));
    }
}

contract ExitsTest is VekilBase {
    event ExitRecorded(bytes32 indexed entryOrderHash, bytes15 exitPrefix, uint8 reason, int64 pnlQuote);

    bytes15 internal constant XP = bytes15(0xfe31d00e8119c79124cb6837bfa3b6);

    function test_recordExit() public {
        (bytes32 h,) = _request(validReq());
        vm.warp(T0 + 600);
        vm.expectEmit(true, false, false, true, address(vp));
        emit ExitRecorded(h, XP, 2, -238525200);
        vm.prank(AGENT);
        vp.recordExit(h, XP, 2, -238525200);
        assertEq(vp.exitRecordedAt(h), T0 + 600);
        assertEq(vp.entryByExitPrefix(XP), h);
    }

    function test_recordExit_unknownEntry() public {
        vm.prank(AGENT);
        vm.expectRevert(VekilPolicy.UnknownEntry.selector);
        vp.recordExit(keccak256("nope"), XP, 1, 0);
    }

    function test_recordExit_rejectedEntryIsUnknown() public {
        VekilPolicy.OrderRequest memory r = validReq();
        r.tpPx = 1;
        (bytes32 h,) = _request(r);
        vm.prank(AGENT);
        vm.expectRevert(VekilPolicy.UnknownEntry.selector);
        vp.recordExit(h, XP, 1, 0);
    }

    function test_recordExit_once() public {
        (bytes32 h,) = _request(validReq());
        vm.startPrank(AGENT);
        vp.recordExit(h, XP, 1, 100);
        vm.expectRevert(VekilPolicy.ExitAlreadyRecorded.selector);
        vp.recordExit(h, XP, 1, 100);
        vm.stopPrank();
    }

    function test_recordExit_reasonRange() public {
        (bytes32 h,) = _request(validReq());
        vm.startPrank(AGENT);
        vm.expectRevert(VekilPolicy.BadExitReason.selector);
        vp.recordExit(h, XP, 0, 0);
        vm.expectRevert(VekilPolicy.BadExitReason.selector);
        vp.recordExit(h, XP, 7, 0);
        vm.stopPrank();
    }

    function test_recordExit_allReasons() public {
        _setPolicy(roomyPolicy(), _avax(), "");
        for (uint8 reason = 1; reason <= 6; reason++) {
            vm.warp(T0 + uint256(reason) * 1 hours); // 5/h, so one approval per hour
            (bytes32 h,) = _request(validReq());
            assertEq(_status(h), 1);
            vm.prank(AGENT);
            vp.recordExit(h, bytes15(keccak256(abi.encode(reason))), reason, int64(-1));
            assertGt(vp.exitRecordedAt(h), 0);
        }
    }

    function test_recordExit_whilePaused() public {
        (bytes32 h,) = _request(validReq());
        vm.prank(OWNER);
        vp.pause();
        vm.prank(AGENT);
        vp.recordExit(h, XP, 5, type(int64).min);
        assertGt(vp.exitRecordedAt(h), 0);
    }
}

contract AnchorsTest is VekilBase {
    event Anchored(uint64 indexed index, bytes32 root, uint64 fromSeq, uint64 toSeq);

    function _anchor(bytes32 root, uint64 fromSeq, uint64 toSeq) internal {
        vm.prank(AGENT);
        vp.anchor(root, fromSeq, toSeq);
    }

    function test_anchor_contiguous() public {
        vm.expectEmit(true, false, false, true, address(vp));
        emit Anchored(0, bytes32(uint256(1)), 1, 10);
        _anchor(bytes32(uint256(1)), 1, 10);
        _anchor(bytes32(uint256(2)), 11, 11);
        assertEq(vp.anchorCount(), 2);
        assertEq(vp.lastAnchoredSeq(), 11);
        (bytes32 root, uint64 fromSeq, uint64 toSeq, uint64 at) = vp.anchors(1);
        assertEq(root, bytes32(uint256(2)));
        assertEq(fromSeq, 11);
        assertEq(toSeq, 11);
        assertEq(at, T0);
    }

    function test_anchor_mustStartAtOne() public {
        vm.prank(AGENT);
        vm.expectRevert(VekilPolicy.BadAnchorRange.selector);
        vp.anchor(bytes32(uint256(1)), 2, 5);
    }

    function test_anchor_gapOrOverlap() public {
        _anchor(bytes32(uint256(1)), 1, 10);
        vm.startPrank(AGENT);
        vm.expectRevert(VekilPolicy.BadAnchorRange.selector);
        vp.anchor(bytes32(uint256(1)), 12, 20);
        vm.expectRevert(VekilPolicy.BadAnchorRange.selector);
        vp.anchor(bytes32(uint256(1)), 10, 20);
        vm.stopPrank();
    }

    function test_anchor_toBeforeFrom() public {
        vm.prank(AGENT);
        vm.expectRevert(VekilPolicy.BadAnchorRange.selector);
        vp.anchor(bytes32(uint256(1)), 1, 0);
    }

    function test_anchor_whilePaused() public {
        vm.prank(OWNER);
        vp.pause();
        _anchor(bytes32(uint256(1)), 1, 3);
        assertEq(vp.lastAnchoredSeq(), 3);
    }
}

/// Frozen vectors from src/shared/vectors.ts. Never change a value to make a test pass.
contract VectorsTest is VekilBase {
    bytes32 constant VECTOR_ORDER_HASH = 0x97c45554ff62e3d9cf7674f5c240d5cff5b476ef600e23ab8ff49be00677bb94;
    bytes32 constant VECTOR_R1_ORDER_HASH = 0x19d72f425c30a6c3408fc8c3fedb1e7e1f8cac944c8b2af8d9235ad69d740f73;
    bytes32 constant VECTOR_INST_ID_HASH = 0x961cc17d242bfaa4355d8d832dd3060b5cb7d2f87d294da145475200eaf1c4c4;
    bytes32 constant VECTOR_EXIT_HASH = 0xfe31d00e8119c79124cb6837bfa3b65278922646e6c5d480b5495f07987d8c61;
    address constant VECTOR_POLICY = 0x5FbDB2315678afecb367f032d93F642f64180aa3;

    bytes32 constant VECTOR_ROOT_1 = 0x2317e718883e0819ef8b538b0816289e105bac61dc281ce036a9b198a2e76fce;
    bytes32 constant VECTOR_ROOT_2 = 0x38b88284f69760e30f0828460c1c592e03db47936d7d5739f9bd10e650ac56ad;
    bytes32 constant VECTOR_ROOT_3 = 0x40f1b93b7e7ea934f750f20d7fa7acdcf3a5149eda297d39bcddaadf69c0aee4;
    bytes32 constant VECTOR_ROOT_5 = 0xb0888dd4f889eef82ed87a9974da223c4d4f236634e97762d418e02c6d740f63;
    bytes32 constant L1 = 0x2317e718883e0819ef8b538b0816289e105bac61dc281ce036a9b198a2e76fce;
    bytes32 constant L2 = 0x8456f9e01e2dcb877839ffd5e7cac6ab1034af36753eaf3406ec4dbd19fdab6c;
    bytes32 constant L3 = 0xf8440c5d96ec78f833a5482690f855e2fffc421ed1d5aa9162a00cbcc06327d0;
    bytes32 constant L4 = 0x2f3a433dafe17389e5e85d9e8e74c485e4d4358ef60c5d8550f9edecf902bfd3;
    bytes32 constant L5 = 0xac29abeed4528883723f53f7b1f92ecb7ec3838a15876814a3868c4d50ab4ace;
    bytes32 constant N12 = 0x38b88284f69760e30f0828460c1c592e03db47936d7d5739f9bd10e650ac56ad;
    bytes32 constant N34 = 0x53edd7a3a200a8c8a2c2eaf6262419000e5996fad7689e83db49153fe134d0d7;
    bytes32 constant N1234 = 0x9876ad988a81c0fcc945dcb238144bed853fecc04ed9e898048d61281fe250d0;

    bytes32 constant VECTOR_POLICY_DEFAULT_HASH = 0xd81ec4bd2adba3c63cb39c8e3a637bed2a57a8c377089df672b9736604a1127c;
    bytes32 constant VECTOR_POLICY_2_SOURCE_TEXT_HASH = 0x0f759e8de8aa0dc0b516e8d7e683d300a2d9334637c20e650040b48e1e0d2fec;
    bytes32 constant VECTOR_POLICY_2_HASH = 0x715037022924ddc2bcb237f8673a13ae1c7a2482b529c2df2ae952f83d8856ab;

    function _entryHash(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("vekil-entry-", vm.toString(i)));
    }

    function test_vector_instIdHash() public pure {
        assertEq(AVAX_TRY, VECTOR_INST_ID_HASH);
    }

    function test_vector_hashOrderFor() public view {
        assertEq(vp.hashOrderFor(43113, VECTOR_POLICY, vectorReq()), VECTOR_ORDER_HASH);
    }

    function test_vector_hashOrderFor_r1() public view {
        VekilPolicy.OrderRequest memory r = vectorReq();
        r.instId = DOGE_TRY;
        r.px = 700700000;
        r.sz = 142714428000;
        r.stopPx = 0;
        r.tpPx = 0;
        r.timeStopMin = 480;
        assertEq(vp.hashOrderFor(31337, VECTOR_POLICY, r), VECTOR_R1_ORDER_HASH);
    }

    function test_vector_exitHash() public pure {
        bytes32 exitNonce = bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333));
        assertEq(keccak256(abi.encode(VECTOR_ORDER_HASH, exitNonce)), VECTOR_EXIT_HASH);
    }

    function test_requestApproval_usesOwnChainAndAddress() public {
        (bytes32 h,) = _request(vectorReq());
        assertEq(h, vp.hashOrderFor(block.chainid, address(vp), vectorReq()));
        assertTrue(h != VECTOR_ORDER_HASH);
    }

    function test_vector_leaves() public pure {
        bytes32[5] memory leaves = [L1, L2, L3, L4, L5];
        for (uint256 i = 0; i < 5; i++) assertEq(keccak256(abi.encodePacked(_entryHash(i + 1))), leaves[i]);
    }

    function test_vector_verifyEntry_5leaves() public {
        vm.prank(AGENT);
        vp.anchor(VECTOR_ROOT_5, 1, 5);
        bytes32[][] memory proofs = new bytes32[][](5);
        proofs[0] = _p3(L2, N34, L5);
        proofs[1] = _p3(L1, N34, L5);
        proofs[2] = _p3(L4, N12, L5);
        proofs[3] = _p3(L3, N12, L5);
        proofs[4] = new bytes32[](1);
        proofs[4][0] = N1234;
        for (uint256 i = 0; i < 5; i++) {
            assertTrue(vp.verifyEntry(0, _entryHash(i + 1), proofs[i]), "proof");
            assertFalse(vp.verifyEntry(0, _entryHash(i + 2), proofs[i]), "wrong entry");
        }
        // tampered proof, unknown anchor index
        bytes32[] memory bad = _p3(L2, N34, L4);
        assertFalse(vp.verifyEntry(0, _entryHash(1), bad));
        assertFalse(vp.verifyEntry(1, _entryHash(1), proofs[0]));
    }

    function test_vector_verifyEntry_1_2_3leaves() public {
        vm.startPrank(AGENT);
        vp.anchor(VECTOR_ROOT_1, 1, 1);
        vp.anchor(VECTOR_ROOT_2, 2, 3);
        vp.anchor(VECTOR_ROOT_3, 4, 6);
        vm.stopPrank();
        assertTrue(vp.verifyEntry(0, _entryHash(1), new bytes32[](0)));
        bytes32[] memory p = new bytes32[](1);
        p[0] = L1;
        assertTrue(vp.verifyEntry(1, _entryHash(2), p));
        p[0] = N12; // leaf 3 of 3 is carried up once
        assertTrue(vp.verifyEntry(2, _entryHash(3), p));
    }

    function test_vector_policyHash_default() public {
        _setPolicy(defaultPolicy(), _avax(), "");
        assertEq(vp.policyHash(), VECTOR_POLICY_DEFAULT_HASH);
        assertEq(vp.sourceTextHash(), keccak256(""));
    }

    function test_vector_policyHash_2() public {
        VekilPolicy.Policy memory p = VekilPolicy.Policy({
            maxOrderQuote: 50e8,
            dailyRiskBudget: 25e8,
            maxTradesPerHour: 3,
            maxTradesPerDay: 10,
            minStopBps: 50,
            maxStopBps: 250,
            maxHoldMin: 240,
            feeBps: 15,
            slippageBps: 25,
            validUntil: VECTOR_VALID_UNTIL
        });
        string[] memory ids = new string[](2);
        ids[0] = "AVAX-TRY";
        ids[1] = "BTC-TRY";
        _setPolicy(p, ids, unicode"Sadece AVAX ve BTC işlem yap. İşlem başına en fazla 50 TL.");
        assertEq(vp.sourceTextHash(), VECTOR_POLICY_2_SOURCE_TEXT_HASH);
        assertEq(vp.policyHash(), VECTOR_POLICY_2_HASH);
    }

    function _p3(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](3);
        p[0] = a;
        p[1] = b;
        p[2] = c;
    }
}
