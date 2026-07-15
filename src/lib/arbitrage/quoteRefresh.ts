import type { ArbLeg, ReasonCode } from "@/types/arbitrage";

const KALSHI_API = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const POLYMARKET_CLOB = "https://clob.polymarket.com";
const SX_API = "https://api.sx.bet";

type PriceLevel = { price: number; contracts: number };

export class QuoteRefreshError extends Error {
  constructor(public reasonCode: ReasonCode, message: string) {
    super(message);
  }
}

export function walkBook(levels: PriceLevel[], size: number): { priceCents: number; liquidityUsd: number } {
  if (!Number.isFinite(size) || size <= 0) throw new QuoteRefreshError("insufficient_depth", "Invalid order size");
  const valid = [...levels]
    .filter((level) => level.price > 0 && level.price < 1 && level.contracts > 0)
    .sort((a, b) => a.price - b.price);
  let remaining = size;
  let worstPrice = 0;
  for (const level of valid) {
    const filled = Math.min(remaining, level.contracts);
    remaining -= filled;
    worstPrice = level.price;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9) {
    throw new QuoteRefreshError("insufficient_depth", `Orderbook is short ${remaining.toFixed(4)} contracts`);
  }
  // Preserve the total executable depth at the FOK limit, not only the requested cost.
  const liquidityUsd = valid
    .filter((level) => level.price <= worstPrice)
    .reduce((sum, level) => sum + level.price * level.contracts, 0);
  return { priceCents: Number((worstPrice * 100).toFixed(4)), liquidityUsd: Number(liquidityUsd.toFixed(4)) };
}

async function json(response: Response, venue: string): Promise<unknown> {
  if (!response.ok) throw new QuoteRefreshError("orderbook_not_ready", `${venue} orderbook returned ${response.status}`);
  return response.json();
}

async function refreshKalshi(leg: ArbLeg): Promise<ArbLeg> {
  const ticker = leg.nativeMarketId;
  const side = leg.nativeSide?.toLowerCase();
  if (!ticker || (side !== "yes" && side !== "no")) {
    throw new QuoteRefreshError("orderbook_not_ready", "Kalshi ticker or side is missing");
  }
  const response = await fetch(`${KALSHI_API}/markets/${encodeURIComponent(ticker)}/orderbook?depth=100`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const body = (await json(response, "Kalshi")) as {
    orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
  };
  const opposite = side === "yes" ? body.orderbook_fp?.no_dollars : body.orderbook_fp?.yes_dollars;
  const levels = (opposite ?? []).map(([price, contracts]) => ({
    price: 1 - Number(price),
    contracts: Number(contracts),
  }));
  return withQuote(leg, walkBook(levels, leg.size));
}

async function refreshPolymarket(leg: ArbLeg): Promise<ArbLeg> {
  const tokenId = leg.nativeMarketId;
  if (!tokenId) throw new QuoteRefreshError("orderbook_not_ready", "Polymarket token ID is missing");
  const response = await fetch(`${POLYMARKET_CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const body = (await json(response, "Polymarket")) as { asks?: Array<{ price: string; size: string }> };
  const levels = (body.asks ?? []).map((level) => ({ price: Number(level.price), contracts: Number(level.size) }));
  return withQuote(leg, walkBook(levels, leg.size));
}

async function refreshSx(leg: ArbLeg): Promise<ArbLeg> {
  const marketHash = leg.nativeMarketId;
  const side = leg.nativeSide;
  if (!marketHash || (side !== "outcome_one" && side !== "outcome_two")) {
    throw new QuoteRefreshError("orderbook_not_ready", "SX market hash or outcome is missing");
  }
  const response = await fetch(`${SX_API}/orders?marketHashes=${encodeURIComponent(marketHash)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const body = (await json(response, "SX.bet")) as {
    data?: Array<{
      percentageOdds: string;
      totalBetSize: string;
      fillAmount: string;
      isMakerBettingOutcomeOne: boolean;
    }>;
  };
  const takerWantsOne = side === "outcome_one";
  const levels: PriceLevel[] = [];
  for (const order of body.data ?? []) {
    if (order.isMakerBettingOutcomeOne === takerWantsOne) continue;
    const makerPrice = Number(order.percentageOdds) / 1e20;
    const remainingMaker = Number(order.totalBetSize) - Number(order.fillAmount);
    if (!(makerPrice > 0 && makerPrice < 1 && remainingMaker > 0)) continue;
    const price = 1 - makerPrice;
    const takerStakeUsd = (remainingMaker * (1 - makerPrice)) / makerPrice / 1e6;
    levels.push({ price, contracts: takerStakeUsd / price });
  }
  return withQuote(leg, walkBook(levels, leg.size));
}

function withQuote(leg: ArbLeg, quote: { priceCents: number; liquidityUsd: number }): ArbLeg {
  return {
    ...leg,
    priceCents: quote.priceCents,
    decimalOdds: 100 / quote.priceCents,
    impliedProbability: quote.priceCents / 100,
    liquidityUsd: quote.liquidityUsd,
  };
}

export async function refreshLegQuotes(legs: ArbLeg[]): Promise<ArbLeg[]> {
  return Promise.all(
    legs.map((leg) => {
      const venue = leg.venueId.toLowerCase();
      if (venue.includes("kalshi")) return refreshKalshi(leg);
      if (venue.includes("poly")) return refreshPolymarket(leg);
      if (venue.includes("sx")) return refreshSx(leg);
      throw new QuoteRefreshError("orderbook_not_ready", `No quote refresher for ${leg.venueId}`);
    })
  );
}
