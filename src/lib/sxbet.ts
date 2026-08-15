// SX.bet venue adapter (read-only, manual §7). SX.bet is an order-book betting
// exchange; taker prices come from resting maker orders. We fetch MLB markets +
// their order books and normalize into the same VenueTwoWay / VenueSpread /
// VenueTotalLine shapes as Kalshi/Polymarket, keyed by ESPN gameId so the matching
// engine treats it as a third venue automatically.
//
// Market types: 226 = moneyline, 28 = total (over/under), 342 = run-line spread.
// Odds: order.percentageOdds is the maker's implied prob (×1e20). A taker filling a
// maker order takes the OPPOSITE outcome at (1 - makerProb).

import { teamsMatch } from "./teamNormalization";
import type { VenueSpread, VenueTotalLine, VenueTwoWay } from "./kalshi";
import type { ArbGame } from "./arbitrage/sports";
import type { ExpectedContractIdentity } from "./arbitrage/execution/types";

const SX_API = "https://api.sx.bet";
const TYPE_MONEYLINE = 226; // baseball/basketball 2-way moneyline
const TYPE_TOTAL = 28;
const TYPE_SPREAD = 342;
const TYPE_TEAM_YESNO = 1; // "X vs Not X" — soccer 1X2 is three of these (home / away / Tie)
const TYPE_TWO_WAY = 52; // 2-way "team1 vs team2" (soccer draw-no-bet; used for tennis winner)
const USDC_DECIMALS = 1e6; // SX.bet collateral is USDC (6 decimals)
const SX_MARKET_CACHE_MS = 30_000;
const SX_ORDER_CACHE_MS = 5_000;
// SX documents 500 requests/minute for general REST endpoints. Serializing this module's
// public reads at 150ms intervals caps it at 400/minute and prevents the all-sports scanner
// from producing a large concurrent burst on startup.
const SX_REST_MIN_GAP_MS = 150;
const SX_DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15_000;

type TimedCache<T> = { value: T; fetchedAt: number };
const activeMarketCache = new Map<string, TimedCache<SxMarket[]>>();
const activeMarketInFlight = new Map<string, Promise<SxMarket[]>>();
const orderCache = new Map<string, TimedCache<SxOrder[]>>();
let sxRestQueue: Promise<void> = Promise.resolve();
let sxLastRestRequestAt = 0;
let sxRestCooldownUntil = 0;

function retryAfterMs(response: Response, now = Date.now()): number {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return SX_DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : SX_DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function scheduledSxFetch(input: string, init: RequestInit): Promise<Response> {
  let release!: () => void;
  const prior = sxRestQueue;
  sxRestQueue = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try {
    const now = Date.now();
    await delay(Math.max(sxRestCooldownUntil - now, sxLastRestRequestAt + SX_REST_MIN_GAP_MS - now));
    sxLastRestRequestAt = Date.now();
    const response = await fetch(input, init);
    if (response.status === 429) {
      sxRestCooldownUntil = Math.max(sxRestCooldownUntil, Date.now() + retryAfterMs(response));
    }
    return response;
  } finally {
    release();
  }
}

type SxMarket = {
  marketHash: string;
  type: number;
  line: number | null;
  outcomeOneName: string;
  outcomeTwoName: string;
  teamOneName: string;
  teamTwoName: string;
  gameTime: number;
};

type SxContractIdentityRecord = SxMarket & { observedAt: number };
type SxContractIdentityStore = Map<string, SxContractIdentityRecord>;
const SX_IDENTITY_MAX_AGE_MS = 60_000;
const sxIdentityGlobal = globalThis as typeof globalThis & { __sxContractIdentityByHash?: SxContractIdentityStore };

function sxContractIdentityStore(): SxContractIdentityStore {
  return (sxIdentityGlobal.__sxContractIdentityByHash ??= new Map());
}

function registerSxContractIdentities(markets: SxMarket[]): void {
  const observedAt = Date.now();
  const store = sxContractIdentityStore();
  for (const market of markets) store.set(market.marketHash, { ...market, observedAt });
}

export function clearSxContractIdentityRegistry(): void {
  sxContractIdentityStore().clear();
}

type SxSpreadDescriptor = Pick<SxMarket, "line" | "outcomeOneName" | "outcomeTwoName">;

function signedTrailingLine(outcomeName: string): number | null {
  // SX supplies the signed handicap in both the structured `line` field and the
  // outcome labels (for example, "Los Angeles Sparks W -2.5"). Parse the label as
  // an independent integrity check; never invent a fallback line for an unfamiliar
  // descriptor because that can match two different native contracts as an arb.
  const match = outcomeName.trim().replaceAll("−", "-").match(/([+-]\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Return SX's exact signed handicap from the home team's perspective.
 *
 * `market.line` is signed for outcome one. The two displayed outcome lines must be
 * exact opposites and must agree with that structured field. Returning null drops the
 * market instead of allowing an ambiguous native contract into cross-venue matching.
 * This is pure in-memory validation over metadata already fetched for discovery, so it
 * adds no request or execution-path latency.
 */
export function sxHomeSignedSpreadLine(market: SxSpreadDescriptor, outcomeOneIsHome: boolean): number | null {
  const oneLine = signedTrailingLine(market.outcomeOneName);
  const twoLine = signedTrailingLine(market.outcomeTwoName);
  if (oneLine == null || twoLine == null || market.line == null || !Number.isFinite(market.line)) return null;

  const epsilon = 1e-9;
  if (Math.abs(oneLine + twoLine) > epsilon || Math.abs(oneLine - market.line) > epsilon) return null;
  return outcomeOneIsHome ? oneLine : twoLine;
}

type SxOrder = {
  marketHash: string;
  percentageOdds: string;
  totalBetSize: string;
  fillAmount: string;
  isMakerBettingOutcomeOne: boolean;
};

// Best taker price + liquidity for each side of a market's order book.
type BookPrices = { o1Cents: number; o2Cents: number; o1LiqUsd: number; o2LiqUsd: number };

function bestPrices(orders: SxOrder[] | undefined): BookPrices | null {
  if (!orders?.length) return null;
  // Makers betting outcome TWO let a taker BUY outcome ONE, and vice versa.
  let bestPforO1 = 0;
  let o1Liq = 0;
  let bestPforO2 = 0;
  let o2Liq = 0;
  for (const o of orders) {
    const avail = Number(o.totalBetSize) - Number(o.fillAmount);
    if (avail <= 0) continue;
    const p = Number(o.percentageOdds) / 1e20;
    if (p <= 0 || p >= 1) continue;
    if (!o.isMakerBettingOutcomeOne) {
      if (p > bestPforO1) {
        bestPforO1 = p;
        o1Liq = avail;
      }
    } else if (p > bestPforO2) {
      bestPforO2 = p;
      o2Liq = avail;
    }
  }
  if (bestPforO1 === 0 || bestPforO2 === 0) return null; // one-sided book
  return {
    o1Cents: Number(((1 - bestPforO1) * 100).toFixed(4)),
    o2Cents: Number(((1 - bestPforO2) * 100).toFixed(4)),
    o1LiqUsd: o1Liq / USDC_DECIMALS,
    o2LiqUsd: o2Liq / USDC_DECIMALS,
  };
}

async function fetchActiveMarkets(leagueId: number, onlyMainLine = true): Promise<SxMarket[]> {
  const cacheKey = `${leagueId}:${onlyMainLine ? "main" : "all"}`;
  const cached = activeMarketCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SX_MARKET_CACHE_MS) {
    registerSxContractIdentities(cached.value);
    return cached.value;
  }
  const existing = activeMarketInFlight.get(cacheKey);
  if (existing) return existing;

  const request = (async () => {
    try {
      const res = await scheduledSxFetch(
        `${SX_API}/markets/active?leagueId=${leagueId}${onlyMainLine ? "&onlyMainLine=true" : ""}`,
        { cache: "no-store", headers: { Accept: "application/json" } }
      );
      if (!res.ok) return cached?.value ?? [];
      const data = await res.json();
      const markets = (data?.data?.markets ?? []) as SxMarket[];
      activeMarketCache.set(cacheKey, { value: markets, fetchedAt: Date.now() });
      registerSxContractIdentities(markets);
      return markets;
    } catch (e) {
      console.error("[sxbet] markets fetch failed:", e);
      return cached?.value ?? [];
    }
  })();
  activeMarketInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (activeMarketInFlight.get(cacheKey) === request) activeMarketInFlight.delete(cacheKey);
  }
}

type SxLeague = { leagueId: number; label: string; sportId: number; active: boolean };

const LEAGUE_CACHE_MS = 60_000;
let leagueCache: { fetchedAt: number; leagues: SxLeague[] } | null = null;
let leagueFetchInFlight: Promise<SxLeague[]> | null = null;

async function fetchLeagues(): Promise<SxLeague[]> {
  const now = Date.now();
  if (leagueCache && now - leagueCache.fetchedAt < LEAGUE_CACHE_MS) return leagueCache.leagues;
  // Every dynamic league (MLS/NWSL/ATP/WTA/etc.) is ingested concurrently. Coalesce
  // those callers into one catalog request so SX does not rate-limit the scan before
  // tournament-specific market reads even begin.
  if (leagueFetchInFlight) return leagueFetchInFlight;

  leagueFetchInFlight = (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await scheduledSxFetch(`${SX_API}/leagues`, { cache: "no-store", headers: { Accept: "application/json" } });
        if (res.ok) {
          const leagues = ((await res.json())?.data ?? []) as SxLeague[];
          leagueCache = { fetchedAt: Date.now(), leagues };
          return leagues;
        }
        lastError = new Error(`HTTP ${res.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    console.error("[sxbet] leagues fetch failed:", lastError);
    // A recently expired catalog is safer than dropping every SX sport from a scan
    // because of a transient rate limit. It is discovery data only; each order book is
    // still fetched fresh below.
    return leagueCache?.leagues ?? [];
  })();

  try {
    return await leagueFetchInFlight;
  } finally {
    leagueFetchInFlight = null;
  }
}

async function fetchOrders(hashes: string[]): Promise<Map<string, SxOrder[]>> {
  const map = new Map<string, SxOrder[]>();
  const now = Date.now();
  const uniqueHashes = [...new Set(hashes)];
  const staleHashes: string[] = [];
  for (const hash of uniqueHashes) {
    const cached = orderCache.get(hash);
    if (cached && now - cached.fetchedAt < SX_ORDER_CACHE_MS) map.set(hash, cached.value);
    else staleHashes.push(hash);
  }

  for (let i = 0; i < staleHashes.length; i += 20) {
    const chunk = staleHashes.slice(i, i + 20);
    try {
      const res = await scheduledSxFetch(`${SX_API}/orders?marketHashes=${chunk.join(",")}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        for (const hash of chunk) {
          const cached = orderCache.get(hash);
          if (cached) map.set(hash, cached.value);
        }
        continue;
      }
      const data = await res.json();
      const byHash = new Map<string, SxOrder[]>();
      for (const o of (data?.data ?? []) as SxOrder[]) {
        (byHash.get(o.marketHash) ?? byHash.set(o.marketHash, []).get(o.marketHash)!).push(o);
      }
      const fetchedAt = Date.now();
      for (const hash of chunk) {
        const orders = byHash.get(hash) ?? [];
        orderCache.set(hash, { value: orders, fetchedAt });
        map.set(hash, orders);
      }
    } catch (e) {
      console.error("[sxbet] orders fetch failed:", e);
      for (const hash of chunk) {
        const cached = orderCache.get(hash);
        if (cached) map.set(hash, cached.value);
      }
    }
  }
  return map;
}

export function clearSxFetchCachesForTests(): void {
  activeMarketCache.clear();
  activeMarketInFlight.clear();
  orderCache.clear();
  leagueCache = null;
  leagueFetchInFlight = null;
  sxRestQueue = Promise.resolve();
  sxLastRestRequestAt = 0;
  sxRestCooldownUntil = 0;
}

function teamHit(name: string, team: { name: string; abbreviation: string }): boolean {
  return teamsMatch(name, team.name) || name.toLowerCase().includes(team.abbreviation.toLowerCase());
}

function sxGameDate(m: SxMarket): string | null {
  if (!Number.isFinite(m.gameTime)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(m.gameTime * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function sxMarketType(market: SxMarket): ExpectedContractIdentity["marketType"] | null {
  if (market.type === TYPE_SPREAD) return "spread";
  if (market.type === TYPE_TOTAL) return "total";
  if (market.type === TYPE_MONEYLINE || market.type === TYPE_TEAM_YESNO || market.type === TYPE_TWO_WAY) return "moneyline";
  return null;
}

// Pure in-memory guard over metadata already fetched by discovery. No venue request is
// made here: live signing is blocked unless the exact native hash still means the same
// teams, outcome, market type, signed line and slate date as the normalized arb leg.
export function validateSxContractIdentity(
  marketHash: string | undefined,
  nativeSide: string | undefined,
  expected: ExpectedContractIdentity | undefined,
  now = Date.now()
): { ok: boolean; reason?: string } {
  if (!marketHash || !nativeSide) return { ok: false, reason: "SX.bet contract identity is missing market hash or side" };
  if (!expected) return { ok: false, reason: "SX.bet contract identity is missing the expected native descriptor" };

  const market = sxContractIdentityStore().get(marketHash);
  if (!market) return { ok: false, reason: `SX.bet contract identity cache has no metadata for ${marketHash}` };
  if (now - market.observedAt > SX_IDENTITY_MAX_AGE_MS) {
    return { ok: false, reason: `SX.bet contract identity metadata is stale (${now - market.observedAt}ms old)` };
  }

  const actualType = sxMarketType(market);
  if (actualType !== expected.marketType) {
    return { ok: false, reason: `SX.bet contract type mismatch: native ${actualType ?? market.type}, expected ${expected.marketType}` };
  }

  const [away, home] = expected.teams;
  const oneIsHome = teamsMatch(market.teamOneName, home);
  const oneIsAway = teamsMatch(market.teamOneName, away);
  const twoIsHome = teamsMatch(market.teamTwoName, home);
  const twoIsAway = teamsMatch(market.teamTwoName, away);
  if (!((oneIsHome && twoIsAway) || (oneIsAway && twoIsHome))) {
    return { ok: false, reason: `SX.bet contract teams do not match ${away} v ${home}` };
  }

  const side = nativeSide.toLowerCase();
  if (side !== "one" && side !== "two") return { ok: false, reason: `SX.bet native side ${nativeSide} is invalid` };
  const expectedTeam = expected.outcome === "home" ? home : expected.outcome === "away" ? away : null;
  const selectedTeam = side === "one" ? market.teamOneName : market.teamTwoName;
  if (expectedTeam && !teamsMatch(selectedTeam, expectedTeam)) {
    return { ok: false, reason: `SX.bet selected side is ${selectedTeam}, expected ${expectedTeam}` };
  }

  if (actualType === "spread") {
    const nativeHomeLine = sxHomeSignedSpreadLine(market, oneIsHome);
    if (nativeHomeLine == null || expected.line == null || Math.abs(nativeHomeLine - expected.line) > 1e-9) {
      return { ok: false, reason: `SX.bet spread mismatch: native home line ${nativeHomeLine ?? "invalid"}, expected ${expected.line ?? "missing"}` };
    }
  } else if (actualType === "total") {
    if (expected.line == null || market.line == null || Math.abs(market.line - expected.line) > 1e-9) {
      return { ok: false, reason: `SX.bet total mismatch: native ${market.line ?? "missing"}, expected ${expected.line ?? "missing"}` };
    }
    const selectedName = side === "one" ? market.outcomeOneName : market.outcomeTwoName;
    if (!selectedName.toLowerCase().startsWith(expected.outcome.toLowerCase())) {
      return { ok: false, reason: `SX.bet selected total outcome is ${selectedName}, expected ${expected.outcome}` };
    }
  }

  const expectedDate = expected.sourceStartTime?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  const nativeDate = sxGameDate(market);
  if (expectedDate && nativeDate !== expectedDate) {
    return { ok: false, reason: `SX.bet contract date mismatch: native ${nativeDate ?? "missing"}, expected ${expectedDate}` };
  }
  return { ok: true };
}

// A market matches a game when its two teams equal the game's away/home in either order.
function marketMatchesGame(m: SxMarket, game: ArbGame): boolean {
  const { awayTeam: a, homeTeam: h } = game;
  return (
    (teamHit(m.teamOneName, a) && teamHit(m.teamTwoName, h)) ||
    (teamHit(m.teamOneName, h) && teamHit(m.teamTwoName, a))
  );
}

function marketMatchesGameDate(m: SxMarket, game: ArbGame): boolean {
  return marketMatchesGame(m, game) && sxGameDate(m) === game.date;
}

export type SxBetMarkets = {
  moneyline: Map<string, VenueTwoWay>;
  spread: Map<string, VenueSpread>;
  totals: Map<string, VenueTotalLine[]>;
};

function collectTotalsByGame(
  games: ArbGame[],
  markets: SxMarket[],
  books: Map<string, SxOrder[]>
): Map<string, VenueTotalLine[]> {
  const out = new Map<string, VenueTotalLine[]>();
  for (const game of games) {
    const totalRows: VenueTotalLine[] = [];
    for (const t of markets.filter((m) => m.type === TYPE_TOTAL && marketMatchesGameDate(m, game))) {
      const bp = bestPrices(books.get(t.marketHash));
      if (!bp || t.line == null) continue;
      const overIsOne = t.outcomeOneName.toLowerCase().startsWith("over");
      const sourceStartTime = sxGameDate(t) ?? game.date;
      totalRows.push({
        line: t.line,
        overCents: overIsOne ? bp.o1Cents : bp.o2Cents,
        underCents: overIsOne ? bp.o2Cents : bp.o1Cents,
        overLiquidityUsd: overIsOne ? bp.o1LiqUsd : bp.o2LiqUsd,
        underLiquidityUsd: overIsOne ? bp.o2LiqUsd : bp.o1LiqUsd,
        marketId: t.marketHash,
        overIsOutcomeOne: overIsOne,
        sourceStartTime,
      });
    }
    if (totalRows.length) out.set(game.id, totalRows);
  }
  return out;
}

// Fetch + normalize all SX.bet markets for the given league + ESPN games.
export async function fetchSxBetMLBMarkets(games: ArbGame[], leagueId: number = 171): Promise<SxBetMarkets> {
  const result: SxBetMarkets = { moneyline: new Map(), spread: new Map(), totals: new Map() };
  if (!games.length) return result;

  const markets = await fetchActiveMarkets(leagueId);
  const relevant = markets.filter((m) => [TYPE_MONEYLINE, TYPE_TOTAL, TYPE_SPREAD].includes(m.type));
  if (!relevant.length) return result;

  const books = await fetchOrders(relevant.map((m) => m.marketHash));

  for (const game of games) {
    const gm = relevant.filter((m) => marketMatchesGameDate(m, game));
    if (!gm.length) continue;

    // Moneyline (226): team names → home/away.
    const ml = gm.find((m) => m.type === TYPE_MONEYLINE);
    if (ml) {
      const bp = bestPrices(books.get(ml.marketHash));
      if (bp) {
        const oneIsAway = teamHit(ml.teamOneName, game.awayTeam);
        result.moneyline.set(game.id, {
          awayCents: oneIsAway ? bp.o1Cents : bp.o2Cents,
          homeCents: oneIsAway ? bp.o2Cents : bp.o1Cents,
          awayLiquidityUsd: oneIsAway ? bp.o1LiqUsd : bp.o2LiqUsd,
          homeLiquidityUsd: oneIsAway ? bp.o2LiqUsd : bp.o1LiqUsd,
          marketId: ml.marketHash,
          homeIsOutcomeOne: !oneIsAway,
          sourceStartTime: sxGameDate(ml) ?? game.date,
        });
      }
    }

    // Spread (342): preserve SX's exact signed native line. WNBA main lines move
    // frequently (-2.5 -> -2, for example), so they must never be coerced to +/-1.5.
    const sp = gm.find((m) => m.type === TYPE_SPREAD);
    if (sp) {
      const bp = bestPrices(books.get(sp.marketHash));
      if (bp) {
        const oneIsHome = teamHit(sp.teamOneName, game.homeTeam);
        const homeSignedLine = sxHomeSignedSpreadLine(sp, oneIsHome);
        if (homeSignedLine != null) {
          result.spread.set(game.id, {
            homeCents: oneIsHome ? bp.o1Cents : bp.o2Cents,
            awayCents: oneIsHome ? bp.o2Cents : bp.o1Cents,
            homeLiquidityUsd: oneIsHome ? bp.o1LiqUsd : bp.o2LiqUsd,
            awayLiquidityUsd: oneIsHome ? bp.o2LiqUsd : bp.o1LiqUsd,
            homeSignedLine,
            marketId: sp.marketHash,
            homeIsOutcomeOne: oneIsHome,
            sourceStartTime: sxGameDate(sp) ?? game.date,
          });
        }
      }
    }

    // Totals (28): "Over N / Under N". SX often uses integer lines (push on exact),
    // which won't match Kalshi/Polymarket .5 lines — that's fine, the matcher drops
    // non-equal lines. We still ingest them for completeness.
    const totalRows = collectTotalsByGame([game], gm, books).get(game.id);
    if (totalRows?.length) result.totals.set(game.id, totalRows);
  }

  return result;
}

// SX.bet has NO native 3-selection market, so soccer 1X2 is three "type 1" (X vs Not X)
// markets — backing outcome ONE of the home-team, away-team, and "Tie" markets yields the
// home/away/draw prices (validated live: home+away+tie ≈ 102¢ overround). Tennis is a
// plain 2-way winner (type 226/52). Leagues are enumerated live by sportId + label because
// SX uses ephemeral per-tournament league ids (a new WTA league per event).
export async function fetchSxBetMoneylineByGame(
  games: ArbGame[],
  opts: { sportId: number; leagueMatch: RegExp; threeWay?: boolean }
): Promise<Map<string, VenueTwoWay>> {
  const out = new Map<string, VenueTwoWay>();
  if (!games.length) return out;

  const leagues = await fetchLeagues();
  const leagueIds = leagues
    .filter((l) => l.active && l.sportId === opts.sportId && opts.leagueMatch.test(l.label))
    .map((l) => l.leagueId);
  if (!leagueIds.length) return out;

  // Fetch across the matched leagues (cap to bound the request count).
  const markets: SxMarket[] = [];
  for (const id of leagueIds.slice(0, 96)) markets.push(...(await fetchActiveMarkets(id, false)));
  if (!markets.length) return out;

  const books = await fetchOrders([...new Set(markets.map((m) => m.marketHash))]);

  for (const game of games) {
    const gm = markets.filter((m) => marketMatchesGameDate(m, game));
    if (!gm.length) continue;

    if (opts.threeWay) {
      // Three "type 1" markets for this game: outcomeOne = home team / away team / Tie.
      const t1 = gm.filter((m) => m.type === TYPE_TEAM_YESNO && !/^not\b/i.test(m.outcomeOneName));
      const homeMkt = t1.find((m) => teamHit(m.outcomeOneName, game.homeTeam));
      const awayMkt = t1.find((m) => teamHit(m.outcomeOneName, game.awayTeam));
      const tieMkt = t1.find((m) => /^(tie|draw)\b/i.test(m.outcomeOneName));
      const hp = homeMkt && bestPrices(books.get(homeMkt.marketHash));
      const ap = awayMkt && bestPrices(books.get(awayMkt.marketHash));
      const tp = tieMkt && bestPrices(books.get(tieMkt.marketHash));
      if (homeMkt && awayMkt && tieMkt && hp && ap && tp) {
        out.set(game.id, {
          // Back outcome ONE of each market = buy that result.
          homeCents: hp.o1Cents,
          awayCents: ap.o1Cents,
          drawCents: tp.o1Cents,
          homeLiquidityUsd: hp.o1LiqUsd,
          awayLiquidityUsd: ap.o1LiqUsd,
          drawLiquidityUsd: tp.o1LiqUsd,
          marketId: homeMkt.marketHash,
          homeTokenId: homeMkt.marketHash,
          awayTokenId: awayMkt.marketHash,
          drawTokenId: tieMkt.marketHash,
          sourceStartTime: sxGameDate(homeMkt) ?? game.date,
        });
      }
      continue;
    }

    // Tennis: a plain 2-way winner market whose two outcomes are the two players.
    const mw =
      gm.find((m) => (m.type === TYPE_MONEYLINE || m.type === TYPE_TWO_WAY) && teamHit(m.teamOneName, game.awayTeam) && teamHit(m.teamTwoName, game.homeTeam)) ??
      gm.find((m) => (m.type === TYPE_MONEYLINE || m.type === TYPE_TWO_WAY) && teamHit(m.teamOneName, game.homeTeam) && teamHit(m.teamTwoName, game.awayTeam));
    if (!mw) continue;
    const bp = bestPrices(books.get(mw.marketHash));
    if (!bp) continue;
    const oneIsAway = teamHit(mw.teamOneName, game.awayTeam);
    out.set(game.id, {
      awayCents: oneIsAway ? bp.o1Cents : bp.o2Cents,
      homeCents: oneIsAway ? bp.o2Cents : bp.o1Cents,
      awayLiquidityUsd: oneIsAway ? bp.o1LiqUsd : bp.o2LiqUsd,
      homeLiquidityUsd: oneIsAway ? bp.o2LiqUsd : bp.o1LiqUsd,
      marketId: mw.marketHash,
      homeIsOutcomeOne: !oneIsAway,
      sourceStartTime: sxGameDate(mw) ?? game.date,
    });
  }
  return out;
}

export async function fetchSxBetTotalsByGame(
  games: ArbGame[],
  opts: { sportId: number; leagueMatch: RegExp }
): Promise<Map<string, VenueTotalLine[]>> {
  if (!games.length) return new Map();

  const leagues = await fetchLeagues();
  const leagueIds = leagues
    .filter((l) => l.active && l.sportId === opts.sportId && opts.leagueMatch.test(l.label))
    .map((l) => l.leagueId);
  if (!leagueIds.length) return new Map();

  const markets: SxMarket[] = [];
  for (const id of leagueIds.slice(0, 96)) {
    markets.push(...(await fetchActiveMarkets(id, false)));
  }
  const relevant = markets.filter((m) => m.type === TYPE_TOTAL);
  if (!relevant.length) return new Map();

  const books = await fetchOrders([...new Set(relevant.map((m) => m.marketHash))]);
  return collectTotalsByGame(games, relevant, books);
}
