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
  it("blocks SX.bet fills below the SX.bet taker minimum", () => {
    expect(liveVenueMinimumStakeBlockers([leg("sxbet", 6, 12)])).toEqual([
      "SX.bet Home stake $0.72 is below minimum $1.01",
    ]);
  });

  it("blocks an SX.bet fill at exactly $1.00 (below the $1.01 minimum)", () => {
    expect(liveVenueMinimumStakeBlockers([leg("sxbet", 10, 10)])).toEqual([
      "SX.bet Home stake $1.00 is below minimum $1.01",
    ]);
  });

  it("requires every venue leg to clear the shared minimum", () => {
    expect(liveVenueMinimumStakeBlockers([leg("sxbet", 10, 11), leg("polymarket", 6, 12)])).toEqual([
      "Polymarket Home stake $0.72 is below minimum $1.01",
    ]);
    expect(liveVenueMinimumStakeBlockers([leg("sxbet", 10, 11), leg("polymarket", 10, 12)])).toEqual([]);
  });

  it("also enforces Predict.fun's two-contract venue rule", () => {
    expect(liveVenueMinimumStakeBlockers([leg("predictfun", 1.5, 80)])).toEqual([
      "Predict.fun Home size 1.50 is below minimum 2.00 contracts",
    ]);
    expect(liveVenueMinimumStakeBlockers([leg("predictfun", 2, 80)])).toEqual([]);
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

  it("places SX.bet first for SX.bet/Kalshi routes (fragile on-chain leg leads)", () => {
    expect(fragileVenueFirstOrder([req("sxbet"), req("kalshi")])).toEqual([0, 1]);
    // Order-independent: Kalshi listed first still yields SX.bet placed first.
    expect(fragileVenueFirstOrder([req("kalshi"), req("sxbet")])).toEqual([1, 0]);
    expect(shouldSequenceFragileVenuePair([req("sxbet"), req("kalshi")])).toBe(true);
  });
});
