// pnpm probe:chain [--local] — deploys its OWN throwaway VekilPolicy (anvil with --local, otherwise Fuji) and
// exercises approve, reject (critical → paused), exit, anchor and verifyEntry. Never touches deployment.json (SPEC §13.3).
import { privateKeyToAccount } from "viem/accounts";
import { startLocalChain, deployVekilPolicy } from "../src/chain/anvil.js";
import { confirmChainWrite, loadScriptConfig, scriptArgs } from "../src/chain/deployment.js";
import { ViemPolicyChain } from "../src/chain/policy-chain.js";
import { keccakUtf8 } from "../src/shared/hash.js";
import type { PolicyChain } from "../src/shared/interfaces.js";
import { merkleProof, merkleRoot } from "../src/shared/merkle.js";
import { entryClOrdId, exitClOrdId, hashPrefix30 } from "../src/shared/order-hash.js";
import { maskToReasons } from "../src/shared/reasons.js";
import { defaultPolicy, type OrderRequest } from "../src/shared/schemas.js";

const results: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${step}: ${detail}`);
}

async function exercise(chain: PolicyChain): Promise<void> {
  const link = (h: string): string => chain.explorerTxUrl(h) ?? h;
  const nonce = (n: string) => keccakUtf8(`probe-${Date.now()}-${n}`);
  const good: OrderRequest = {
    instId: "AVAX-TRY", side: "buy", px: "494.7", sz: "0.4", stopPx: "488.8", tpPx: "506.6", timeStopMin: 240,
    decisionHash: keccakUtf8("probe-decision"), nonce: nonce("good"),
  };
  const a = await chain.requestApproval(good, { timeoutMs: 30_000 });
  check("approve", a.ok && a.status === "APPROVED", a.ok ? `${a.status} ${link(a.txHash)} clOrdId ${entryClOrdId(a.orderHash)}` : a.error);
  if (!a.ok) return;
  const byPrefix = await chain.orderHashByPrefix(hashPrefix30(a.orderHash));
  check("orderHashByPrefix", byPrefix === a.orderHash, String(byPrefix));

  const xId = exitClOrdId(a.orderHash, nonce("exit"));
  const ex = await chain.recordExit(a.orderHash, xId.slice(1), 1, "-1.25");
  check("recordExit", ex.ok, ex.ok ? link(ex.txHash) : ex.error);
  check("entryByExitPrefix", (await chain.entryByExitPrefix(xId.slice(1))) === a.orderHash, xId);

  const rogue: OrderRequest = {
    instId: "DOGE-TRY", side: "buy", px: "7.007", sz: "1427.14428", stopPx: "0", tpPx: "0", timeStopMin: 240,
    decisionHash: keccakUtf8("probe-rogue"), nonce: nonce("rogue"),
  };
  const r = await chain.requestApproval(rogue, { timeoutMs: 30_000 });
  check("reject R1 (critical)", r.ok && r.status === "REJECTED" && r.critical, r.ok ? `${maskToReasons(r.reasonsMask).join(",")} critical=${r.critical} ${link(r.txHash)}` : r.error);
  check("auto-pause", (await chain.readView()).paused, "paused == true");

  const entries = [a.orderHash, keccakUtf8("e2"), keccakUtf8("e3")];
  const from = (await chain.lastAnchoredSeq()) + 1;
  const an = await chain.anchor(merkleRoot(entries), from, from + entries.length - 1);
  check("anchor (allowed while paused)", an.ok, an.ok ? link(an.txHash) : an.error);
  const anchors = await chain.readAnchors();
  const idx = anchors.at(-1)?.index ?? 0;
  const ok = await chain.verifyEntry(idx, entries[1]!, merkleProof(entries, 1));
  check("verifyEntry", ok, `anchor #${idx}`);

  const un = await chain.unpause();
  check("owner unpause", un.ok, un.ok ? link(un.txHash) : un.error);
}

async function main(): Promise<void> {
  const args = scriptArgs();
  if (args.includes("--local")) {
    const lc = await startLocalChain();
    try {
      console.log(`anvil ${lc.anvil.rpcUrl}; VekilPolicy ${lc.deployment.address}`);
      await exercise(lc.chain);
    } finally {
      await lc.stop();
    }
  } else {
    const cfg = loadScriptConfig({ CHAIN: process.env.CHAIN === "mainnet" ? "mainnet" : "fuji" });
    if (!cfg.ownerPrivateKey || !cfg.agentPrivateKey || !cfg.rpcUrl) throw new Error("OWNER_PRIVATE_KEY and AGENT_PRIVATE_KEY are required");
    await confirmChainWrite(cfg, "probe:chain deploys a throwaway contract and sends ~7 txs", args);
    const agent = privateKeyToAccount(cfg.agentPrivateKey).address;
    const d = await deployVekilPolicy({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, ownerKey: cfg.ownerPrivateKey, agentAddress: agent });
    const chain = new ViemPolicyChain({
      rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, address: d.address, agentKey: cfg.agentPrivateKey, ownerKey: cfg.ownerPrivateKey, fromBlock: d.deployBlock,
    });
    console.log(`throwaway VekilPolicy ${d.address}: ${chain.explorerTxUrl(d.txHash) ?? d.txHash}`);
    const sp = await chain.setPolicy(defaultPolicy(Date.now()));
    if (!sp.ok) throw new Error(sp.error);
    await exercise(chain);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `✗ ${failed} step(s) failed` : `✓ all ${results.length} steps passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
