// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VekilPolicy} from "../src/VekilPolicy.sol";

/// Shared fixtures. Values mirror src/shared/vectors.ts (frozen in M0).
abstract contract VekilBase is Test {
    VekilPolicy internal vp;

    address internal constant OWNER = address(0x0A11CE);
    address internal constant AGENT = address(0xA6E47);
    address internal constant STRANGER = address(0xBAD);

    uint64 internal constant HARD_MAX_ORDER = 1000e8;
    uint64 internal constant HARD_MAX_RISK = 500e8;

    // 2026-10-17 09:00:00 Europe/Istanbul (06:00Z); hour-aligned.
    uint64 internal constant T0 = 1792216800;
    // VECTOR_VALID_UNTIL_MS / 1000: 2026-10-17 23:59:59 Europe/Istanbul.
    uint64 internal constant VECTOR_VALID_UNTIL = 1792270799;

    bytes32 internal constant AVAX_TRY = keccak256("AVAX-TRY");
    bytes32 internal constant BTC_TRY = keccak256("BTC-TRY");
    bytes32 internal constant DOGE_TRY = keccak256("DOGE-TRY");

    // reason bits (SPEC §9.4)
    uint32 internal constant R_PAUSED = 1 << 0;
    uint32 internal constant R_POLICY_EXPIRED = 1 << 1;
    uint32 internal constant R_INSTRUMENT = 1 << 2;
    uint32 internal constant R_SIDE = 1 << 3;
    uint32 internal constant R_ZERO = 1 << 4;
    uint32 internal constant R_TOO_LARGE = 1 << 5;
    uint32 internal constant R_STOP_MISSING = 1 << 6;
    uint32 internal constant R_STOP_INVALID = 1 << 7;
    uint32 internal constant R_STOP_TIGHT = 1 << 8;
    uint32 internal constant R_STOP_WIDE = 1 << 9;
    uint32 internal constant R_TP_INVALID = 1 << 10;
    uint32 internal constant R_TIME_STOP = 1 << 11;
    uint32 internal constant R_HOURLY = 1 << 12;
    uint32 internal constant R_DAILY = 1 << 13;
    uint32 internal constant R_RISK = 1 << 14;

    uint256 internal nonceCounter;

    function setUp() public virtual {
        vm.warp(T0);
        vm.prank(OWNER);
        vp = new VekilPolicy(AGENT, HARD_MAX_ORDER, HARD_MAX_RISK);
        _setPolicy(defaultPolicy(), _avax(), "");
    }

    // ---------------------------------------------------------------- policies

    /// The default policy (SPEC §11) with the frozen vector's validUntil.
    function defaultPolicy() internal pure returns (VekilPolicy.Policy memory p) {
        p = VekilPolicy.Policy({
            maxOrderQuote: 200e8,
            dailyRiskBudget: 100e8,
            maxTradesPerHour: 1,
            maxTradesPerDay: 4,
            minStopBps: 30,
            maxStopBps: 300,
            maxHoldMin: 480,
            feeBps: 20,
            slippageBps: 30,
            validUntil: VECTOR_VALID_UNTIL
        });
    }

    /// A roomy policy for counter tests: 5/h, 10/day, valid for 30 days.
    function roomyPolicy() internal pure returns (VekilPolicy.Policy memory p) {
        p = defaultPolicy();
        p.maxTradesPerHour = 5;
        p.maxTradesPerDay = 10;
        p.validUntil = T0 + 30 days;
    }

    function _avax() internal pure returns (string[] memory ids) {
        ids = new string[](1);
        ids[0] = "AVAX-TRY";
    }

    function _setPolicy(VekilPolicy.Policy memory p, string[] memory ids, string memory text) internal {
        vm.prank(OWNER);
        vp.setPolicy(p, ids, text);
    }

    // ---------------------------------------------------------------- requests

    /// VECTOR_REQ: AVAX-TRY buy px 494.7, sz 0.40428, stop 488.8, tp 506.6, 240 min. Notional ≈ 199.997 TL.
    function vectorReq() internal pure returns (VekilPolicy.OrderRequest memory r) {
        r = VekilPolicy.OrderRequest({
            instId: AVAX_TRY,
            side: 1,
            px: 49470000000,
            sz: 40428000,
            stopPx: 48880000000,
            tpPx: 50660000000,
            timeStopMin: 240,
            decisionHash: bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
            nonce: bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222))
        });
    }

    /// A valid request with a fresh nonce.
    function validReq() internal returns (VekilPolicy.OrderRequest memory r) {
        r = vectorReq();
        r.nonce = keccak256(abi.encode("nonce", ++nonceCounter));
    }

    function _request(VekilPolicy.OrderRequest memory r) internal returns (bytes32 h, uint32 reasons) {
        vm.prank(AGENT);
        (h, reasons) = vp.requestApproval(r);
    }

    function _status(bytes32 h) internal view returns (uint8 status) {
        (status,,,,,) = vp.approvals(h);
    }

    function _reasons(bytes32 h) internal view returns (uint32 reasons) {
        (, reasons,,,,) = vp.approvals(h);
    }

    function _hourIndex(uint256 ts) internal pure returns (uint64) {
        return uint64((ts + 10800) / 3600);
    }

    function _dayIndex(uint256 ts) internal pure returns (uint64) {
        return uint64((ts + 10800) / 86400);
    }
}
