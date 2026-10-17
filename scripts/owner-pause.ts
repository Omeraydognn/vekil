// pnpm owner:pause [--unpause] — the owner's on-chain brake (SPEC §13.3, §17).
import { confirmChainWrite, loadScriptConfig, openPolicyChain, scriptArgs } from "../src/chain/deployment.js";

async function main(): Promise<void> {
  const args = scriptArgs();
  const unpause = args.includes("--unpause");
  const cfg = loadScriptConfig();
  const { chain } = openPolicyChain(cfg, { owner: true });
  const view = await chain.readView();
  console.log(`contract ${chain.address} on ${cfg.chain}: paused=${view.paused}`);
  if (view.paused === !unpause) {
    console.log(unpause ? "already unpaused" : "already paused");
    return;
  }
  await confirmChainWrite(cfg, unpause ? "unpause()" : "pause()", args);
  const res = unpause ? await chain.unpause() : await chain.pause();
  if (!res.ok) throw new Error(res.error);
  console.log(`${unpause ? "unpaused" : "paused"}: ${chain.explorerTxUrl(res.txHash) ?? res.txHash}`);
  if (unpause) console.log("Next: stop the processes, run `pnpm resume` (human only), then start again.");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
