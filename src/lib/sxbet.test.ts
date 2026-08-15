import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArbGame } from "./arbitrage/sports";
import {
  clearSxFetchCachesForTests,
  clearSxContractIdentityRegistry,
  fetchSxBetMLBMarkets,
  sxHomeSignedSpreadLine,
  validateSxContractIdentity,
} from "./sxbet";

const game: ArbGame = {
  id: "401857136",
  date: "2026-08-11",
  awayTeam: { name: "Phoenix Mercury", shortName: "Mercury", abbreviation: "PHX" },
  homeTeam: { name: "Los Angeles Sparks", shortName: "Sparks", abbreviation: "LAS" },
};

const spread = (overrides: Partial<{
  line: number | null;
  outcomeOneName: string;
  outcomeTwoName: string;
}> = {}) => ({
  line: -2.5,
  outcomeOneName: "Los Angeles Sparks W -2.5",
  outcomeTwoName: "Phoenix Mercury W +2.5",
  ...overrides,
});

describe("SX.bet spread normalization", () => {
  afterEach(() => {
    clearSxFetchCachesForTests();
    clearSxContractIdentityRegistry();
    vi.unstubAllGlobals();
  });

  it("preserves moving WNBA main lines instead of coercing them to +1.5", () => {
    expect(sxHomeSignedSpreadLine(spread(), true)).toBe(-2.5);
    expect(sxHomeSignedSpreadLine(spread({
      line: -2,
      outcomeOneName: "Los Angeles Sparks W -2",
      outcomeTwoName: "Phoenix Mercury W +2",
    }), true)).toBe(-2);
  });

  it("returns the opposite signed line when outcome one is the away team", () => {
    expect(sxHomeSignedSpreadLine(spread({
      line: -1.5,
      outcomeOneName: "Phoenix Mercury W -1.5",
      outcomeTwoName: "Los Angeles Sparks W +1.5",
    }), false)).toBe(1.5);
  });

  it("rejects ambiguous or internally inconsistent SX descriptors", () => {
    expect(sxHomeSignedSpreadLine(spread({ line: -2 }), true)).toBeNull();
    expect(sxHomeSignedSpreadLine(spread({
      outcomeOneName: "Los Angeles Sparks W",
      outcomeTwoName: "Phoenix Mercury W",
    }), true)).toBeNull();
    expect(sxHomeSignedSpreadLine(spread({
      outcomeTwoName: "Phoenix Mercury W +2",
    }), true)).toBeNull();
  });

  it("threads the exact native handicap into the normalized venue spread", async () => {
    const marketHash = "0xspread";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/markets/active")) {
        return new Response(JSON.stringify({ data: { markets: [{
          status: "ACTIVE",
          marketHash,
          type: 342,
          line: -2.5,
          outcomeOneName: "Los Angeles Sparks W -2.5",
          outcomeTwoName: "Phoenix Mercury W +2.5",
          teamOneName: "Los Angeles Sparks W",
          teamTwoName: "Phoenix Mercury W",
          gameTime: 1786500000,
        }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [
        { marketHash, percentageOdds: "50000000000000000000", totalBetSize: "10000000", fillAmount: "0", isMakerBettingOutcomeOne: false },
        { marketHash, percentageOdds: "50000000000000000000", totalBetSize: "10000000", fillAmount: "0", isMakerBettingOutcomeOne: true },
      ] }), { status: 200 });
    }));

    const result = await fetchSxBetMLBMarkets([game], 1384);
    expect(result.spread.get(game.id)).toMatchObject({
      marketId: marketHash,
      homeSignedLine: -2.5,
      homeIsOutcomeOne: true,
    });

    const expected = {
      marketType: "spread" as const,
      line: -2.5,
      outcome: "home",
      teams: ["Mercury", "Sparks"] as [string, string],
      sourceStartTime: "2026-08-11",
    };
    expect(validateSxContractIdentity(marketHash, "one", expected)).toEqual({ ok: true });

    const wrongLine = validateSxContractIdentity(marketHash, "one", { ...expected, line: 1.5 });
    expect(wrongLine.ok).toBe(false);
    expect(wrongLine.reason).toContain("spread mismatch");

    const wrongSide = validateSxContractIdentity(marketHash, "two", expected);
    expect(wrongSide.ok).toBe(false);
    expect(wrongSide.reason).toContain("selected side");
  });

  it("fails closed when discovery has not registered the native contract", () => {
    const missing = validateSxContractIdentity("0xmissing", "one", {
      marketType: "spread",
      line: -2,
      outcome: "home",
      teams: ["Mercury", "Sparks"],
      sourceStartTime: "2026-08-11",
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("no metadata");
  });

  it("caches market metadata and order books across rapid scanner cycles", async () => {
    const marketHash = "0xcached";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/markets/active")) {
        return new Response(JSON.stringify({ data: { markets: [{
          marketHash,
          type: 226,
          line: null,
          outcomeOneName: "Los Angeles Sparks W",
          outcomeTwoName: "Phoenix Mercury W",
          teamOneName: "Los Angeles Sparks W",
          teamTwoName: "Phoenix Mercury W",
          gameTime: 1786500000,
        }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [
        { marketHash, percentageOdds: "50000000000000000000", totalBetSize: "10000000", fillAmount: "0", isMakerBettingOutcomeOne: false },
        { marketHash, percentageOdds: "50000000000000000000", totalBetSize: "10000000", fillAmount: "0", isMakerBettingOutcomeOne: true },
      ] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchSxBetMLBMarkets([game], 1384);
    await fetchSxBetMLBMarkets([game], 1384);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
