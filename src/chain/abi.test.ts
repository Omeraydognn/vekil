import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ARTIFACT_PATH, renderAbiModule } from "../../scripts/abi-sync.js";

const ABI_TS = new URL("./abi.ts", import.meta.url);

describe("abi.ts", () => {
  it.skipIf(!existsSync(ARTIFACT_PATH))("matches the forge artifact (run pnpm abi:sync)", () => {
    expect(readFileSync(ABI_TS, "utf8")).toBe(renderAbiModule(readFileSync(ARTIFACT_PATH, "utf8")));
  });
});
