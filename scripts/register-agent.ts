// pnpm register-agent [--dry-run] [--yes] — ERC-8004 identity for this VEKİL deployment (SPEC §13.4, M15).
// 1. register(agentURI) on the Identity Registry from the owner key (agentURI = the agent card as a data: URI),
// 2. write $DATA_DIR/agent-id.json, 3. VekilPolicy.setAgentId(agentId). Idempotent: an existing agent-id.json for
// this contract skips step 1. --dry-run only simulates register (no tx). Fuji asks y on a TTY (or --yes).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { chainKeys, confirmChainWrite, loadScriptConfig, openPolicyChain, scriptArgs } from "../src/chain/deployment.js";
import { agentCard, dataUri, registerAgent, resumeRegister } from "../src/chain/erc8004.js";

const AgentIdFile = z.object({ chainId: z.number().int(), policy: z.string(), registry: z.string(), agentId: z.number().int().nonnegative(), txHash: z.string() });
const REPO = "https://github.com/Omeraydognn/vekil";

async function main(): Promise<void> {
  const args = scriptArgs();
  const dryRun = args.includes("--dry-run");
  const cfg = loadScriptConfig();
  if (cfg.chain !== "fuji" && cfg.chain !== "mainnet") throw new Error("ERC-8004 registry is on Fuji/mainnet; set CHAIN=fuji");
  const { chain } = openPolicyChain(cfg, { owner: true });
  const { ownerKey } = chainKeys(cfg);
  if (!ownerKey || !cfg.rpcUrl) throw new Error("OWNER_PRIVATE_KEY and an RPC URL are required");
  const view = await chain.readView();
  const card = agentCard({
    chainId: cfg.chainId,
    agent: view.agent,
    policy: chain.address,
    registry: cfg.erc8004IdentityRegistry,
    repo: REPO,
    guardManifest: process.env.GUARD_PUBLIC_URL ? `${process.env.GUARD_PUBLIC_URL.replace(/\/$/, "")}/.well-known/vekil-guard.json` : undefined,
  });
  const file = join(cfg.dataDir, "agent-id.json");
  const pendingFile = join(cfg.dataDir, "agent-id.pending.json");
  const prior = existsSync(file) ? AgentIdFile.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
  const reuse = prior && prior.chainId === cfg.chainId && prior.policy === chain.address && prior.registry === cfg.erc8004IdentityRegistry ? prior : null;

  if (dryRun) {
    const r = await registerAgent({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, registry: cfg.erc8004IdentityRegistry, ownerKey, agentURI: dataUri(card), dryRun: true });
    console.log(`dry run: register would mint agentId ${r.agentId} on ${cfg.erc8004IdentityRegistry}; contract agentId now ${view.agentId}; ${reuse ? `agent-id.json already has #${reuse.agentId}` : "no agent-id.json yet"}`);
    console.log("nothing sent");
    return;
  }
  writeFileSync(new URL("../docs/agent-card.json", import.meta.url), JSON.stringify(card, null, 2) + "\n");

  await confirmChainWrite(cfg, reuse ? `VekilPolicy.setAgentId(${reuse.agentId})` : "ERC-8004 register + VekilPolicy.setAgentId", args);
  let agentId: number;
  if (reuse) {
    agentId = reuse.agentId;
    console.log(`agent-id.json: ERC-8004 #${agentId} (tx ${reuse.txHash}); skipping register`);
  } else {
    const base = { rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, registry: cfg.erc8004IdentityRegistry, ownerKey };
    // A tx sent by an earlier run that didn't finish (timeout, RPC error): resume it, never mint a second identity.
    const pending = existsSync(pendingFile) ? z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), policy: z.string() }).parse(JSON.parse(readFileSync(pendingFile, "utf8"))) : null;
    const r = pending && pending.policy === chain.address
      ? await resumeRegister({ ...base, txHash: pending.txHash as `0x${string}` })
      : await registerAgent({ ...base, agentURI: dataUri(card), onSent: (txHash) => writeFileSync(pendingFile, JSON.stringify({ txHash, policy: chain.address }) + "\n") });
    if (r.txHash === null) throw new Error("register returned no tx");
    agentId = r.agentId;
    writeFileSync(file, JSON.stringify({ chainId: cfg.chainId, policy: chain.address, registry: cfg.erc8004IdentityRegistry, agentId, txHash: r.txHash }, null, 2) + "\n");
    rmSync(pendingFile, { force: true });
    console.log(`registered ERC-8004 #${agentId}: ${chain.explorerTxUrl(r.txHash) ?? r.txHash}`);
  }
  if (view.agentId === agentId) {
    console.log(`VekilPolicy.agentId is already ${agentId}`);
    return;
  }
  const tx = await chain.setAgentId(agentId);
  if (!tx.ok) throw new Error(`setAgentId failed: ${tx.error}`);
  console.log(`VekilPolicy.setAgentId(${agentId}): ${chain.explorerTxUrl(tx.txHash) ?? tx.txHash}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
