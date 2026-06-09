import { GameMarket, OddsOption } from "@/types";
import { WNBAGame } from "@/types/wnba";
import { wnbaTeamMatchesTitle, wnbaTeamsMatch } from "./wnbaTeams";

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
  markets: PolymarketMarket[];
  volume?: string;
  startDate?: string;
  endDate?: string;
};

async function fetchWNBAEvents(): Promise<PolymarketEvent[]> {
  const params = new URLSearchParams({
    tag_slug: "wnba",
    closed: "false",
    limit: "200",
  });
  try {
    // Response can exceed Next.js's 2MB data-cache limit — skip it.
    const res = await fetch(`${GAMMA_API}/events?${params}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const events: PolymarketEvent[] = Array.isArray(data) ? data : data.events ?? [];
    return events.filter((ev) => /vs\.?/i.test(ev.title));
  } catch (err) {
    console.error("[WNBA Polymarket] fetch error:", err);
    return [];
  }
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
  } catch { /* ignore */ }
  if (outcomes.length === 0 && market.tokens) {
    outcomes = market.tokens.map((t) => t.outcome);
    prices = market.tokens.map((t) => t.price ?? null);
  }
  return { outcomes, prices };
}

function priceToDisplayCents(price: number | null | undefined): string {
  if (price == null) return "N/A";
  return `${Math.round(price * 100)}¢`;
}

function formatVolume(vol: string | number | null | undefined): string | null {
  if (vol == null) return null;
  const num = typeof vol === "string" ? parseFloat(vol) : vol;
  if (isNaN(num) || num === 0) return null;
  if (num >= 1000) return `$${(num / 1000).toFixed(2)}K`;
  return `$${num.toFixed(0)}`;
}

function signedLine(val: number): string {
  return val > 0 ? `+${val}` : `${val}`;
}

function classifyMarket(market: PolymarketMarket): "moneyline" | "spread" | "total" | null {
  const q = market.question.toLowerCase();
  if (/o\/u|over|under/.test(q) && !q.includes("spread")) return "total";
  if (q.startsWith("spread:") || q.includes("spread:")) return "spread";
  const { outcomes } = parseOutcomes(market);
  if (
    outcomes.length === 2 &&
    !q.includes("quarter") &&
    !q.includes("point") &&
    !q.includes("rebound")
  ) return "moneyline";
  return null;
}

function buildMoneylineOptions(
  market: PolymarketMarket,
  awayAbbr: string,
  homeAbbr: string,
  awayName: string,
): OddsOption[] {
  const { outcomes, prices } = parseOutcomes(market);
  const mapped = outcomes.map((outcome, i) => {
    const price = prices[i] ?? null;
    const matchesAway = wnbaTeamsMatch(outcome, awayName) || outcome.toLowerCase().includes(awayAbbr.toLowerCase());
    return {
      label: matchesAway ? awayAbbr : homeAbbr,
      price,
      displayPrice: priceToDisplayCents(price),
      isAway: matchesAway,
    };
  });
  const awayOpt = mapped.find((m) => m.isAway) ?? mapped[0];
  const homeOpt = mapped.find((m) => !m.isAway) ?? mapped[1];
  return [awayOpt, homeOpt].filter(Boolean).map(({ label, price, displayPrice }) => ({ label, price, displayPrice }));
}

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
  const titleFavorsAway = wnbaTeamMatchesTitle(awayName, awayAbbr, awayAbbr, q);
  const favLine = lineMag !== null ? (q.includes(`-${lineMag}`) ? -lineMag : lineMag) : null;

  const mapped = outcomes.map((outcome, i) => {
    const price = prices[i] ?? null;
    const outcomeMatchesAway = wnbaTeamsMatch(outcome, awayName) || outcome.toLowerCase().includes(awayAbbr.toLowerCase());
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
  return [awayOpt, homeOpt].filter(Boolean).map(({ label, price, displayPrice }) => ({ label, price, displayPrice }));
}

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

function gameMatchesEvent(game: WNBAGame, event: PolymarketEvent): boolean {
  const title = event.title;
  const awayMatches = wnbaTeamMatchesTitle(game.awayTeam.name, game.awayTeam.shortName, game.awayTeam.abbreviation, title);
  const homeMatches = wnbaTeamMatchesTitle(game.homeTeam.name, game.homeTeam.shortName, game.homeTeam.abbreviation, title);
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

// Pick the event with the most complete market set (moneyline+spread+total), breaking
// ties by most recent startDate. Newer low-volume events often only have a moneyline
// and would leave spread/total blank if picked solely by recency.
function pickBestEvent(matched: PolymarketEvent[], gameDate: string): PolymarketEvent {
  const inWindow = matched.filter((ev) => {
    const start = (ev.startDate ?? "").slice(0, 10);
    const end = (ev.endDate ?? "").slice(0, 10);
    return (!start || start <= gameDate) && (!end || end >= gameDate);
  });
  const pool = inWindow.length > 0 ? inWindow : matched;
  const livePool = pool.filter(eventHasLivePrices);
  const sortPool = livePool.length > 0 ? livePool : pool;

  const typeScore = (ev: PolymarketEvent): number => {
    const types = new Set<string | null>();
    for (const m of ev.markets ?? []) types.add(classifyMarket(m));
    types.delete(null);
    return types.size;
  };

  const maxScore = Math.max(...sortPool.map(typeScore), 0);
  const bestPool = sortPool.filter((ev) => typeScore(ev) >= maxScore);
  return bestPool.sort((a, b) =>
    (b.startDate ?? "").slice(0, 10).localeCompare((a.startDate ?? "").slice(0, 10))
  )[0];
}

export async function fetchWNBAPolymarketData(games: WNBAGame[]): Promise<Map<string, GameMarket>> {
  const events = await fetchWNBAEvents();
  const marketMap = new Map<string, GameMarket>();

  for (const game of games) {
    const matchedEvents = events.filter((ev) => gameMatchesEvent(game, ev));
    if (matchedEvents.length === 0) continue;

    const matchedEvent = pickBestEvent(matchedEvents, game.date);

    const gameMarket: GameMarket = {
      moneyline: [],
      spread: [],
      total: [],
      volume: formatVolume(matchedEvent.volume),
    };

    for (const market of matchedEvent.markets ?? []) {
      const type = classifyMarket(market);
      if (!type) continue;
      const { prices } = parseOutcomes(market);
      if (isSettledMarket(prices)) continue;
      const hasPrices = hasRealPrices(prices);

      if (type === "moneyline" && (gameMarket.moneyline.length === 0 || hasPrices)) {
        gameMarket.moneyline = buildMoneylineOptions(market, game.awayTeam.abbreviation, game.homeTeam.abbreviation, game.awayTeam.name);
      } else if (type === "spread" && (gameMarket.spread.length === 0 || hasPrices)) {
        gameMarket.spread = buildSpreadOptions(market, game.awayTeam.abbreviation, game.homeTeam.abbreviation, game.awayTeam.name);
      } else if (type === "total" && (gameMarket.total.length === 0 || hasPrices)) {
        gameMarket.total = buildTotalOptions(market);
      }
    }

    marketMap.set(game.id, gameMarket);
  }

  return marketMap;
}
