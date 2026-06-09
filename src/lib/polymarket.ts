import { GameMarket, MLBGame, OddsOption } from "@/types";
import { teamMatchesTitle, teamsMatch } from "./teamNormalization";

const GAMMA_API = "https://gamma-api.polymarket.com";

type PolymarketMarket = {
  id: string;
  question: string;
  volume?: string;
  outcomes?: string;
  outcomePrices?: string;
  tokens?: Array<{ token_id: string; outcome: string; price?: number }>;
};

type PolymarketEvent = {
  id: string;
  title: string;
  slug: string;
  markets: PolymarketMarket[];
  volume?: string;
  startDate?: string;
  endDate?: string;
};

// Fetch all open MLB game-level events from Polymarket
async function fetchMLBEvents(): Promise<PolymarketEvent[]> {
  const params = new URLSearchParams({
    tag_slug: "mlb",
    closed: "false",
    limit: "200",
  });

  try {
    // Response is ~11MB — bigger than Next.js's 2MB data-cache limit.
    // `cache: "no-store"` skips that cache layer entirely.
    const res = await fetch(`${GAMMA_API}/events?${params}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.error("[Polymarket] fetch failed:", res.status);
      return [];
    }
    const data = await res.json();
    const events: PolymarketEvent[] = Array.isArray(data) ? data : data.events || [];
    return events.filter((ev) => /vs\.?/i.test(ev.title));
  } catch (err) {
    console.error("[Polymarket] fetch error:", err);
    return [];
  }
}

// Pick the best matching event for a game on a specific date.
//
// Problem: Polymarket creates multiple events per series. Newer (lower-volume) events
// often have only a moneyline market while the older higher-volume event has the full
// moneyline + spread + total set. Sorting purely by newest startDate picks the wrong
// event and results in missing spread/total data.
//
// Fix: score events by number of distinct market types (moneyline/spread/total), prefer
// the most complete event, and break ties by most recent startDate.
function pickBestEvent(
  matched: PolymarketEvent[],
  gameDate: string // YYYY-MM-DD
): PolymarketEvent {
  const inWindow = matched.filter((ev) => {
    const start = (ev.startDate ?? "").slice(0, 10);
    const end = (ev.endDate ?? "").slice(0, 10);
    return (!start || start <= gameDate) && (!end || end >= gameDate);
  });

  const pool = inWindow.length > 0 ? inWindow : matched;
  const livePool = pool.filter(eventHasLivePrices);
  const sortPool = livePool.length > 0 ? livePool : pool;

  // Count distinct non-null market types in each event
  const typeScore = (ev: PolymarketEvent): number => {
    const types = new Set<MarketType>();
    for (const m of ev.markets ?? []) {
      const t = classifyMarket(m);
      if (t) types.add(t);
    }
    return types.size;
  };

  // Prefer most-complete events; among ties pick newest startDate
  const maxScore = Math.max(...sortPool.map(typeScore), 0);
  const bestPool = sortPool.filter((ev) => typeScore(ev) >= maxScore);
  return bestPool.sort((a, b) =>
    (b.startDate ?? "").slice(0, 10).localeCompare((a.startDate ?? "").slice(0, 10))
  )[0];
}

function priceToDisplayCents(price: number | null | undefined): string {
  if (price == null) return "N/A";
  return `${Math.round(price * 100)}¢`;
}

function parseOutcomes(market: PolymarketMarket): { outcomes: string[]; prices: (number | null)[] } {
  let outcomes: string[] = [];
  let prices: (number | null)[] = [];

  try {
    if (market.outcomes) outcomes = JSON.parse(market.outcomes);
    if (market.outcomePrices) {
      prices = JSON.parse(market.outcomePrices).map((p: string | null) =>
        p != null && p !== "" ? Number(p) : null
      );
    }
  } catch {
    // ignore
  }

  if (outcomes.length === 0 && market.tokens) {
    outcomes = market.tokens.map((t) => t.outcome);
    prices = market.tokens.map((t) => t.price ?? null);
  }

  return { outcomes, prices };
}

function formatVolume(vol: string | number | null | undefined): string | null {
  if (vol == null) return null;
  const num = typeof vol === "string" ? parseFloat(vol) : vol;
  if (isNaN(num) || num === 0) return null;
  if (num >= 1000) return `$${(num / 1000).toFixed(2)}K`;
  return `$${num.toFixed(0)}`;
}

type MarketType = "moneyline" | "spread" | "total" | null;

function classifyMarket(market: PolymarketMarket): MarketType {
  const q = market.question.toLowerCase();
  if (/o\/u|over|under/.test(q) && !q.includes("spread")) return "total";
  if (q.startsWith("spread:") || q.includes("spread:")) return "spread";
  // 2-outcome markets without game-prop keywords → moneyline
  const { outcomes } = parseOutcomes(market);
  if (
    outcomes.length === 2 &&
    !q.includes("inning") &&
    !q.includes("run") &&
    !q.includes("hit") &&
    !q.includes("strikeout") &&
    !q.includes("score")
  ) {
    return "moneyline";
  }
  return null;
}

function signedLine(val: number): string {
  return val > 0 ? `+${val}` : `${val}`;
}

// Build moneyline options in [away, home] order
function buildMoneylineOptions(
  market: PolymarketMarket,
  awayAbbr: string,
  homeAbbr: string,
  awayName: string,
): OddsOption[] {
  const { outcomes, prices } = parseOutcomes(market);

  const mapped = outcomes.map((outcome, i) => {
    const price = prices[i] ?? null;
    const matchesAway =
      teamsMatch(outcome, awayName) ||
      outcome.toLowerCase().includes(awayAbbr.toLowerCase());
    return {
      label: matchesAway ? awayAbbr : homeAbbr,
      price,
      displayPrice: priceToDisplayCents(price),
      isAway: matchesAway,
    };
  });

  const awayOpt = mapped.find((m) => m.isAway) ?? mapped[0];
  const homeOpt = mapped.find((m) => !m.isAway) ?? mapped[1];
  return [awayOpt, homeOpt]
    .filter(Boolean)
    .map(({ label, price, displayPrice }) => ({ label, price, displayPrice }));
}

// Build spread options in [away, home] order
// e.g. "Spread: Toronto Blue Jays (-1.5)" → away="LAA +1.5", home="TOR -1.5"
function buildSpreadOptions(
  market: PolymarketMarket,
  awayAbbr: string,
  homeAbbr: string,
  awayName: string,
): OddsOption[] {
  const { outcomes, prices } = parseOutcomes(market);
  const q = market.question;

  const lineMatch = q.match(/[+-]?(\d+\.5)/);
  const lineMag = lineMatch ? parseFloat(lineMatch[1]) : null;
  // Which team is named in the spread title? That team has the stated line sign.
  const titleFavorsAway = teamMatchesTitle(awayName, awayAbbr, awayAbbr, q);
  const favLine = lineMag !== null ? (q.includes(`-${lineMag}`) ? -lineMag : lineMag) : null;

  const mapped = outcomes.map((outcome, i) => {
    const price = prices[i] ?? null;
    const outcomeMatchesAway =
      teamsMatch(outcome, awayName) ||
      outcome.toLowerCase().includes(awayAbbr.toLowerCase());
    const abbr = outcomeMatchesAway ? awayAbbr : homeAbbr;

    let label = abbr;
    if (favLine !== null) {
      const line = titleFavorsAway
        ? outcomeMatchesAway ? favLine : -favLine
        : outcomeMatchesAway ? -favLine : favLine;
      label = `${abbr} ${signedLine(line)}`;
    }

    return { label, price, displayPrice: priceToDisplayCents(price), isAway: outcomeMatchesAway };
  });

  const awayOpt = mapped.find((m) => m.isAway) ?? mapped[0];
  const homeOpt = mapped.find((m) => !m.isAway) ?? mapped[1];
  return [awayOpt, homeOpt]
    .filter(Boolean)
    .map(({ label, price, displayPrice }) => ({ label, price, displayPrice }));
}

// Build total (O/U) options: Over first, Under second
function buildTotalOptions(market: PolymarketMarket): OddsOption[] {
  const { outcomes, prices } = parseOutcomes(market);
  const q = market.question;
  const lineMatch = q.match(/(\d+\.?\d*)/g);
  const line = lineMatch ? lineMatch[lineMatch.length - 1] : null;

  return outcomes.map((outcome, i) => {
    const price = prices[i] ?? null;
    const isOver = outcome.toLowerCase() === "over" || outcome.toLowerCase() === "yes";
    const label = line ? `${isOver ? "O" : "U"} ${line}` : outcome;
    return { label, price, displayPrice: priceToDisplayCents(price) };
  });
}

// Check whether a Polymarket event matches an ESPN game (order-independent)
function gameMatchesEvent(game: MLBGame, event: PolymarketEvent): boolean {
  const title = event.title;

  const awayMatches = teamMatchesTitle(
    game.awayTeam.name,
    game.awayTeam.shortName,
    game.awayTeam.abbreviation,
    title
  );
  const homeMatches = teamMatchesTitle(
    game.homeTeam.name,
    game.homeTeam.shortName,
    game.homeTeam.abbreviation,
    title
  );

  return awayMatches && homeMatches;
}

// A market is settled when any price is within 1% of 0 or 100%
function isSettledMarket(prices: (number | null)[]): boolean {
  const valid = prices.filter((p): p is number => p !== null);
  if (valid.length === 0) return false;
  return valid.some((p) => p >= 0.99 || p <= 0.01);
}

function hasRealPrices(prices: (number | null)[]): boolean {
  return prices.some((p) => p !== null && p > 0.01 && p < 0.99);
}

function eventHasLivePrices(event: PolymarketEvent): boolean {
  return (event.markets ?? []).some((m) => {
    const { prices } = parseOutcomes(m);
    return hasRealPrices(prices);
  });
}

export async function fetchPolymarketData(
  games: MLBGame[],
): Promise<Map<string, GameMarket>> {
  const events = await fetchMLBEvents();
  const marketMap = new Map<string, GameMarket>();

  for (const game of games) {
    // Find all events matching this game (may have multiple per series)
    const matchedEvents = events.filter((ev) => gameMatchesEvent(game, ev));

    if (matchedEvents.length === 0) continue;

    // Pick the event whose date window best matches the game date
    const gameDate = game.date; // YYYY-MM-DD from ESPN
    const matchedEvent = pickBestEvent(matchedEvents, gameDate);

    const gameMarket: GameMarket = {
      moneyline: [],
      spread: [],
      total: [],
      volume: formatVolume(matchedEvent.volume),
    };

    for (const market of matchedEvent.markets || []) {
      const type = classifyMarket(market);
      if (!type) continue;

      const { prices } = parseOutcomes(market);

      // Skip settled markets
      if (isSettledMarket(prices)) continue;

      const hasPrices = hasRealPrices(prices);

      if (type === "moneyline") {
        if (gameMarket.moneyline.length === 0 || hasPrices) {
          gameMarket.moneyline = buildMoneylineOptions(
            market,
            game.awayTeam.abbreviation,
            game.homeTeam.abbreviation,
            game.awayTeam.name,
          );
        }
      } else if (type === "spread") {
        if (gameMarket.spread.length === 0 || hasPrices) {
          gameMarket.spread = buildSpreadOptions(
            market,
            game.awayTeam.abbreviation,
            game.homeTeam.abbreviation,
            game.awayTeam.name,
          );
        }
      } else if (type === "total") {
        if (gameMarket.total.length === 0 || hasPrices) {
          gameMarket.total = buildTotalOptions(market);
        }
      }
    }

    marketMap.set(game.id, gameMarket);
  }

  return marketMap;
}

