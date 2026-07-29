import { describe, expect, it } from "vitest";
import type { ArbLeg } from "@/types/arbitrage";
import { fragileVenueFirstOrder, liveVenueMinimumStakeBlockers, shouldSequenceFragileVenuePair } from "./executor";
import type { OrderRequest } from "./types";

function leg(venueId: string, size: number, priceCents: number): ArbLeg {
  return {
    venueId,
    marketId: `${venueId}:m`,
    outcome: "home",
    priceCents,
    decimalOdds: 100 / priceCents,
    impliedProbability: priceCents / 100,
    size,
    feeCents: 0,
    label: "Home",
  };
}

describe("executor live venue minimum stake guard", () => {
  it("blocks SX.bet fills below the 1 USDC taker minimum", () => {
    expect(liveVenueMinimumStakeBlockers([leg("sxbet", 6, 12)])).toEqual([
      "SX.bet Home stake $0.72 is below minimum $1",
    ]);
  });

  it("allows SX.bet fills at the minimum and ignores other venues", () => {
    expect(liveVenueMinimumStakeBlockers([leg("sxbet", 10, 10), leg("polymarket", 6, 12)])).toEqual([]);
  });
});

describe("executor SX.bet execution ordering", () => {
  const req = (venueId: string): OrderRequest => ({
    venueId,
    marketId: `${venueId}:m`,
    nativeMarketId: `${venueId}:native`,
    nativeSide: venueId === "sxbet" ? "one" : "yes",
    outcome: "home",
    sizeContracts: 5,
    limitPriceCents: 50,
  });

  it("places Polymarket first when the live route includes SX.bet", () => {
    expect(fragileVenueFirstOrder([req("polymarket"), req("sxbet")])).toEqual([0, 1]);
  });

  it("places Polymarket first when the live route includes Kalshi but not SX.bet", () => {
    expect(fragileVenueFirstOrder([req("kalshi"), req("polymarket")])).toEqual([1, 0]);
  });

  it("places Polymarket first when the live route includes predict.fun", () => {
    expect(fragileVenueFirstOrder([req("predictfun"), req("polymarket")])).toEqual([1, 0]);
  });

  it("still sequences Polymarket/Kalshi when Polymarket is already first", () => {
    const requests = [req("polymarket"), req("kalshi")];
    expect(fragileVenueFirstOrder(requests)).toEqual([0, 1]);
    expect(shouldSequenceFragileVenuePair(requests)).toBe(true);
  });

  it("places Kalshi first for SX.bet/Kalshi routes", () => {
    expect(fragileVenueFirstOrder([req("sxbet"), req("kalshi")])).toEqual([1, 0]);
  });
});
