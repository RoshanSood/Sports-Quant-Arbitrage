import { kalshiGet, KalshiCreds } from "./kalshiAuth";
import { teamMatchesTitle } from "./teamNormalization";
import { MLBGame } from "@/types";

const GAME_SERIES = "KXMLBGAME";

type KM = {
  ticker: string;
  yes_sub_title?: string;
  status?: string;
  yes_bid?: number;
  yes_ask?: number;
  yes_bid_dollars?: string | number;
  yes_ask_dollars?: string | number;
  close_time?: string;
};

type KE = {
  event_ticker: string;
  title?: string;
  sub_title?: string;
  markets?: KM[];
};

export type KalshiPrice = {
  probability: number; // 0–1
  askCents: number;    // integer 1–99
};

export type KalshiMoneyline = {
  home: KalshiPrice | null;
  away: KalshiPrice | null;
};

function getAskCents(m: KM): number | null {
  // yes_ask is Kalshi's canonical integer-cents field — always prefer it
  if (m.yes_ask != null && Number.isFinite(m.yes_ask) && m.yes_ask >= 1 && m.yes_ask <= 99) {
    return Math.round(m.yes_ask);
  }
  if (m.yes_ask_dollars != null) {
    const n = Number(m.yes_ask_dollars);
    if (Number.isFinite(n) && n >= 0.01 && n <= 0.99) return Math.round(n * 100);
  }
  return null;
}

function isUsable(m: KM): boolean {
  return m.status !== "settled" && m.status !== "closed";
}

// Kalshi's KXMLBGAME series includes run-line and total markets in addition to moneyline.
// Run-line yes_sub_title looks like "New York Yankees -1.5"; moneyline is just "New York Yankees".
// Exclude any market whose subtitle contains a numeric spread value.
function isMoneylineMarket(m: KM): boolean {
  const sub = (m.yes_sub_title ?? "").trim();
  return !/[+\-]\d/.test(sub);
}

function matchesTeam(team: { name: string; abbreviation: string }, text: string): boolean {
  return teamMatchesTitle(team.name, team.name, team.abbreviation, text);
}

function eventMatchesTeams(
  away: { name: string; abbreviation: string },
  home: { name: string; abbreviation: string },
  ev: KE
): boolean {
  const text = [ev.title, ev.sub_title].filter(Boolean).join(" ");
  if (!text) return false;
  return matchesTeam(away, text) && matchesTeam(home, text);
}

function yesSideTeam(
  m: KM,
  away: { name: string; abbreviation: string },
  home: { name: string; abbreviation: string }
): "away" | "home" | null {
  const text = m.yes_sub_title ?? "";
  if (!text.trim()) return null;
  const a = matchesTeam(away, text);
  const h = matchesTeam(home, text);
  if (a && !h) return "away";
  if (h && !a) return "home";
  return null;
}

async function fetchSeriesEvents(creds?: KalshiCreds): Promise<KE[]> {
  const params = new URLSearchParams({
    series_ticker: GAME_SERIES,
    status: "open",
    with_nested_markets: "true",
    limit: "200",
  });
  try {
    const data = await kalshiGet<{ events?: KE[] }>(`/events?${params}`, {}, creds);
    return data.events ?? [];
  } catch {
    return [];
  }
}

// Returns a map of gameId → KalshiMoneyline (home/away ask prices).
// Works without auth — Kalshi event data is public.
export async function fetchKalshiMoneylines(
  games: MLBGame[],
  creds?: KalshiCreds
): Promise<Map<string, KalshiMoneyline>> {
  const events = await fetchSeriesEvents(creds);
  const result = new Map<string, KalshiMoneyline>();

  for (const game of games) {
    const away = { name: game.awayTeam.name, abbreviation: game.awayTeam.abbreviation };
    const home = { name: game.homeTeam.name, abbreviation: game.homeTeam.abbreviation };

    const gameEvents = events.filter((ev) => eventMatchesTeams(away, home, ev));
    if (!gameEvents.length) {
      result.set(game.id, { home: null, away: null });
      continue;
    }

    let allMarkets = gameEvents.flatMap((ev) => ev.markets ?? []).filter(isUsable).filter(isMoneylineMarket);

    // Narrow to game day: close_time ≈ first pitch.
    // Allow same UTC date or +1 day (for late games that cross midnight UTC).
    if (game.date) {
      const gameDate = game.date; // "YYYY-MM-DD"
      const nextDate = (() => {
        const d = new Date(gameDate + "T12:00:00Z");
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      })();
      const sameDayMarkets = allMarkets.filter((m) => {
        if (!m.close_time) return true;
        const mDate = m.close_time.slice(0, 10);
        return mDate === gameDate || mDate === nextDate;
      });
      if (sameDayMarkets.length > 0) allMarkets = sameDayMarkets;
    }

    let homePrice: KalshiPrice | null = null;
    let awayPrice: KalshiPrice | null = null;

    for (const m of allMarkets) {
      const side = yesSideTeam(m, away, home);
      if (!side) continue;
      const askCents = getAskCents(m);
      if (!askCents) continue;
      const price: KalshiPrice = { probability: askCents / 100, askCents };
      if (side === "home" && !homePrice) homePrice = price;
      if (side === "away" && !awayPrice) awayPrice = price;
    }

    result.set(game.id, { home: homePrice, away: awayPrice });
  }

  return result;
}
