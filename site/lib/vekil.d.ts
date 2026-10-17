// Types for the plain-JS public client (used by the parity test in src/guard/site-parity.test.ts).
export declare const DEFAULTS: { chainId: number; rpcUrl: string; address: string; explorer: string; erc8004Registry: string };
export declare const POLICY_REASONS: string[];
export declare const REASON_TR: Record<string, string>;
export declare const CRITICAL_MASK: number;
export declare function toScaled(s: string): bigint;
export declare function fromScaled(v: bigint | string): string;
export declare function maskToReasons(mask: number): string[];
export declare function withTr(codes: string[]): { code: string; tr: string }[];
export declare function parseCheck(body: unknown): { instId: string; px: bigint; sz: bigint; stopPx: bigint; tpPx: bigint; timeStopMin: number | undefined };
export declare function makeVekil(viem: unknown, opts?: Partial<typeof DEFAULTS>): unknown;
