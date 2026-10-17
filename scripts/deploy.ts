// pnpm chain:fuji | chain:mainnet — deploy VekilPolicy from the committed bytecode with the owner key,
// agent = address(AGENT_PRIVATE_KEY), caps 1000/500 TL; setPolicy(default); write $DATA_DIR/deployment.json (SPEC §13.3).
import { deployVekilPolicy } from "../src/chain/anvil.js";
import { addressOf, chainKeys, confirmChainWrite, loadScriptConfig, scriptArgs, writeDeployment } from "../src/chain/deployment.js";
import { ViemPolicyChain } from "../src/chain/policy-chain.js";
import { defaultPolicy } from "../src/shared/schemas.js";

async function main(): Promise<void> {
  const args = scriptArgs();
  const i = args.indexOf("--chain");
  const chainName = i >= 0 ? args[i + 1] : undefined;
  if (chainName !== "fuji" && chainName !== "mainnet") throw new Error("usage: deploy.ts --chain fuji|mainnet");
  // The deploy needs no LLM; keep a missing ANTHROPIC_API_KEY from blocking it.
  const cfg = loadScriptConfig({ CHAIN: chainName });
  const { agentKey, ownerKey } = chainKeys(cfg);
  if (!ownerKey || !agentKey) throw new Error("OWNER_PRIVATE_KEY and AGENT_PRIVATE_KEY are required");
  if (!cfg.rpcUrl) throw new Error("no RPC URL");
  const agent = addressOf(agentKey);
  console.log(`deploy VekilPolicy on ${cfg.chain} (chainId ${cfg.chainId}); owner ${addressOf(ownerKey)}, agent ${agent}; data dir ${cfg.dataDir}`);
  await confirmChainWrite(cfg, "Deploy VekilPolicy", args);

  const d = await deployVekilPolicy({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, ownerKey, agentAddress: agent });
  writeDeployment(cfg.dataDir, { chainId: cfg.chainId, ...d, deployedAt: Date.now() });
  const chain = new ViemPolicyChain({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, address: d.address, ownerKey, fromBlock: d.deployBlock });
  console.log(`deployed ${d.address} at block ${d.deployBlock}: ${chain.explorerTxUrl(d.txHash) ?? d.txHash}`);
  const res = await chain.setPolicy(defaultPolicy(Date.now()));
  if (!res.ok) throw new Error(`setPolicy(default) failed: ${res.error}`);
  console.log(`default policy set: ${chain.explorerTxUrl(res.txHash) ?? res.txHash}`);
  console.log(`wrote ${cfg.dataDir}/deployment.json`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
