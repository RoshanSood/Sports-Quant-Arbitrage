// predict.fun venue adapter (read side). predict.fun is an on-chain CLOB prediction
// market on BNB Chain (USDT collateral) — same shape as Polymarket. It lists MLB game
// markets under the SPORTS_TEAM_MATCH variant ("Away vs. Home", 2-outcome moneyline).
// Reads are authenticated with an x-api-key (PREDICTFUN_API_KEY). Each market's outcomes
// already carry bestAsk (executable buy price) + size, so top-of-book pricing needs one
// markets call, no per-market orderbook fetch. Normalized into the shared VenueTwoWay
// shape so matching + arb detection treat it as another venue.
//
// predict.fun sports are moneyline only (no totals/spreads in the feed). The per-outcome
// on-chain token id (outcome.onChainId) is threaded for later order placement.

import type { VenueTwoWay } from "./kalshi";
import type { ArbGame } from "./arbitrage/sports";
import { teamsMatch } from "./teamNormalization";

const API = "https://api.predict.fun";
const SPORTS_VARIANT = "SPORTS_TEAM_MATCH";

type PfAmount = { price: number; size: number } | null;
type PfOutcome = { name: string; indexSet: number; onChainId: string; bestBid?: PfAmount; bestAsk?: PfAmount };
type PfMarket = {
  id: number;
  title: string;
  conditionId?: string;
  feeRateBps?: number;
  tradingStatus?: string;
  outcomes?: PfOutcome[];
};

function apiKey(): string | undefined {
  return process.env.PREDICTFUN_API_KEY?.trim() || undefined;
}

async function fetchTeamMatchMarkets(): Promise<PfMarket[]> {
  const key = apiKey();
  if (!key) return []; // no key → no predict.fun rows (read stays empty, never throws)
  try {
    const url = `${API}/v1/markets?status=OPEN&first=200&marketVariant=${SPORTS_VARIANT}`;
    const r = await fetch(url, { cache: "no-store", headers: { "x-api-key": key, Accept: "application/json" } });
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: PfMarket[] };
    return j.data ?? [];
  } catch (e) {
    console.error("[predict.fun] markets fetch failed:", e);
    return [];
  }
}

const cents = (a?: PfAmount): number | null => {
  const p = a?.price;
  return typeof p === "number" && p > 0 && p < 1 ? Number((p * 100).toFixed(4)) : null;
};

// Split "Tampa Bay Rays vs. New York Yankees" → ["Tampa Bay Rays", "New York Yankees"].
function splitTitle(title: string): [string, string] | null {
  const parts = title.split(/\s+vs\.?\s+/i);
  return parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : null;
}

// predict.fun MLB moneyline per game. Title order = outcome order (outcomes[0] is the
// first-named team). Map each side to the game's home/away by team name.
export async function fetchPredictFunMoneylineByGame(games: ArbGame[]): Promise<Map<string, VenueTwoWay>> {
  const out = new Map<string, VenueTwoWay>();
  if (!games.length) return out;
  const markets = await fetchTeamMatchMarkets();
  if (!markets.length) return out;

  for (const game of games) {
    const hit = markets.find((m) => {
      if (m.tradingStatus && m.tradingStatus !== "OPEN") return false;
      const names = splitTitle(m.title);
      if (!names || (m.outcomes ?? []).length < 2) return false;
      const [a, b] = names;
      return (
        (teamsMatch(a, game.awayTeam.name) && teamsMatch(b, game.homeTeam.name)) ||
        (teamsMatch(a, game.homeTeam.name) && teamsMatch(b, game.awayTeam.name))
      );
    });
    if (!hit) continue;
    const names = splitTitle(hit.title)!;
    const firstIsAway = teamsMatch(names[0], game.awayTeam.name);
    const [o0, o1] = hit.outcomes as [PfOutcome, PfOutcome];
    const awayOutcome = firstIsAway ? o0 : o1;
    const homeOutcome = firstIsAway ? o1 : o0;
    const awayCents = cents(awayOutcome.bestAsk);
    const homeCents = cents(homeOutcome.bestAsk);
    if (awayCents == null || homeCents == null) continue;

    out.set(game.id, {
      homeCents,
      awayCents,
      homeLiquidityUsd: (homeOutcome.bestAsk?.size ?? 0) * (homeCents / 100),
      awayLiquidityUsd: (awayOutcome.bestAsk?.size ?? 0) * (awayCents / 100),
      marketId: String(hit.id),
      // On-chain token id per outcome — threaded for order placement (like Polymarket).
      homeTokenId: homeOutcome.onChainId,
      awayTokenId: awayOutcome.onChainId,
    });
  }
  return out;
}
