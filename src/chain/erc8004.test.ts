import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { agentCard, agentIdFromLogs, dataUri, erc8004IdentityAbi } from "./erc8004.js";

const REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const OWNER = "0x9d640856b9e79396f5610a58f4063c349bcddcb4";
const OTHER = "0x29c298e70cb3fbaa0cf484c5e9a744c283e04f86";
const ZERO = "0x0000000000000000000000000000000000000000";

const transfer = (address: string, from: string, to: string, tokenId: bigint) => ({
  address,
  topics: encodeEventTopics({ abi: erc8004IdentityAbi, eventName: "Transfer", args: { from: from as Hex, to: to as Hex, tokenId } }) as [Hex, ...Hex[]],
  data: "0x" as Hex,
});

describe("ERC-8004 mint parsing", () => {
  it("takes the tokenId of the registry's mint to the owner", () => {
    const logs = [transfer(REGISTRY, OTHER, OWNER, 7n), transfer(OTHER, ZERO, OWNER, 9n), transfer(REGISTRY, ZERO, OWNER, 280n)];
    expect(agentIdFromLogs(logs, REGISTRY, OWNER)).toBe(280);
  });
  it("throws when there is no mint to the owner", () => {
    expect(() => agentIdFromLogs([transfer(REGISTRY, ZERO, OTHER, 1n)], REGISTRY, OWNER)).toThrow(/no ERC-8004 mint/);
    expect(() => agentIdFromLogs([{ address: REGISTRY, topics: [], data: encodeAbiParameters([{ type: "uint256" }], [1n]) }], REGISTRY, OWNER)).toThrow();
  });
});

describe("agent card", () => {
  it("follows the EIP-8004 registration shape and round-trips as a data URI", () => {
    const card = agentCard({ chainId: 43113, agent: OTHER, policy: "0x75C9b0155b0b026f869351ab3450723c44e57999", registry: REGISTRY, repo: "https://github.com/Omeraydognn/vekil" });
    expect(card.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(card.endpoints).toContainEqual({ name: "VekilPolicy", endpoint: "eip155:43113:0x75c9b0155b0b026f869351ab3450723c44e57999" });
    expect(card.registrations).toEqual([{ agentRegistry: `eip155:43113:${REGISTRY}` }]);
    const uri = dataUri(card);
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    expect(JSON.parse(Buffer.from(uri.split(",")[1]!, "base64").toString("utf8"))).toEqual(card);
  });
});
