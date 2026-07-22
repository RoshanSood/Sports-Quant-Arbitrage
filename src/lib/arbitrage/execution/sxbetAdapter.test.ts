import { describe, expect, it } from "vitest";
import { TypedDataEncoder, Wallet, verifyTypedData } from "ethers";
import { buildFillTypedData, desiredOddsFor, stakeWeiFor, type FillSignParams } from "./sxbetAdapter";

describe("SX.bet fill math", () => {
  it("stakeWei = contracts × price in 6-decimal USDC", () => {
    expect(stakeWeiFor(10, 50)).toBe("5000000"); // 10 @ 50c = $5.00
    expect(stakeWeiFor(1, 100)).toBe("1000000"); // 1 @ $1.00 = $1.00
    expect(stakeWeiFor(3, 33)).toBe("990000"); // 3 @ 33c = $0.99
    expect(stakeWeiFor(0, 50)).toBe("0");
  });

  it("desiredOdds = takerImpliedProb × 1e20 (= cents × 1e18)", () => {
    expect(desiredOddsFor(50)).toBe("50000000000000000000"); // 0.5 × 1e20
    expect(desiredOddsFor(62)).toBe("62000000000000000000");
    expect(desiredOddsFor(86.125)).toBe("86125000000000000000");
    expect(desiredOddsFor(100)).toBe("100000000000000000000"); // 1.0 × 1e20
  });
});

describe("SX.bet EIP-712 taker-fill signature", () => {
  // Well-known test key → deterministic address.
  const wallet = new Wallet("0x0000000000000000000000000000000000000000000000000000000000000001");
  const params: FillSignParams = {
    stakeWei: "5000000",
    marketHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    baseToken: "0x6629Ce1Cf35Cc1329ebB4F63202F3f197b3F050B",
    desiredOdds: "50000000000000000000",
    oddsSlippage: 0,
    isTakerBettingOutcomeOne: true,
    fillSalt: "12345678901234567890",
    domainVersion: "6.0",
    verifyingContract: "0x845a2Da2D70fEDe8474b1C8518200798c60aC364",
  };

  it("produces a signature that recovers the signer (schema is well-formed)", async () => {
    const { domain, types, message } = buildFillTypedData(params);
    const sig = await wallet.signTypedData(domain, types, message);
    expect(verifyTypedData(domain, types, message, sig)).toBe(wallet.address);
  });

  it("uses EIP712FillHasher as verifyingContract on chain 4162 with Details primary type", () => {
    const { domain, types } = buildFillTypedData(params);
    expect(domain.chainId).toBe(4162);
    expect(domain.verifyingContract).toBe("0x845a2Da2D70fEDe8474b1C8518200798c60aC364");
    // ethers picks Details as the primary type (Details references FillObject, nothing references Details).
    expect(TypedDataEncoder.getPrimaryType(types)).toBe("Details");
  });
});
