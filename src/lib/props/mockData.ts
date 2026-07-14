// Mock MLB prop rows for Phase 1 (UI shell). Typed against the canonical model so
// the client can render the full grid before the provider adapter exists. Numbers
// are internally consistent — fair American odds are derived from the fair
// probability via the real oddsMath, not hand-typed. Swapped for live provider data
// behind a USE_MOCK flag in a later phase.

import type {
  BookSummary,
  DisplayQuote,
  PropsBootstrap,
  PropsGridRow,
  ProviderHealth,
  Side,
} from "@/types/props";
import { BOOKS } from "./books";
import { americanToDecimal, americanToProbability } from "./oddsMath";
import type { ArbLegPick } from "@/types/props";

// Sample rows are DFS-anchored (PrizePicks) to preview the Phase-2 look; the client
// re-anchors them onto the default sportsbook for the Phase-1 view.
const MOCK_ANCHOR_BOOK_ID = "prizepicks";
import { DEFAULT_FILTERS } from "./config";
import { probabilityToAmerican } from "./oddsMath";
import { DEFAULT_PERIOD, getStatById } from "./statRegistry";

function agoISO(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

let quoteSeq = 0;
function q(
  bookId: string,
  side: Side,
  line: number,
  americanOdds: number | null,
  extra: Partial<DisplayQuote> = {}
): DisplayQuote {
  quoteSeq += 1;
  return {
    quoteId: `mock-q-${quoteSeq}`,
    bookId,
    side,
    line,
    americanOdds,
    available: true,
    observedAt: agoISO(20 + (quoteSeq % 40)),
    ...extra,
  };
}

type RowSpec = {
  rowId: string;
  player: { participantId: string; name: string; team: string; position?: string };
  event: { eventId: string; home: string; away: string; startInHours: number };
  statId: string;
  side: Side;
  anchorLine: number;
  anchorMultiplier?: number;
  anchorPromo?: DisplayQuote["promo"];
  fairHitProbability: number | null;
  consensusLine: number | null;
  directionalLineEdge: number | null;
  breakEven: number | null;
  confidence: number;
  score: number;
  reason: PropsGridRow["discrepancy"]["reason"];
  flags: PropsGridRow["flags"];
  cells: Record<string, DisplayQuote | null>;
};

const SPECS: RowSpec[] = [
  {
    rowId: "row-skubal-ks",
    player: { participantId: "mlb-skubal", name: "Tarik Skubal", team: "DET", position: "SP" },
    event: { eventId: "mlb-401-det-cle", home: "CLE", away: "DET", startInHours: 3 },
    statId: "PITCHER_STRIKEOUTS",
    side: "OVER",
    anchorLine: 7.5,
    fairHitProbability: 0.5732,
    consensusLine: 8.5,
    directionalLineEdge: 1.0,
    breakEven: 0.5,
    confidence: 0.82,
    score: 91,
    reason: "LINE_GAP",
    flags: ["FAVORABLE_LINE_GAP", "HIGH_HIT_PROBABILITY"],
    cells: {
      underdog: q("underdog", "OVER", 7.5, null, { multiplier: 1 }),
      sleeper: q("sleeper", "OVER", 8.0, null, { multiplier: 1 }),
      pinnacle: q("pinnacle", "OVER", 8.5, -118, { cellState: "best" }),
      circa: q("circa", "OVER", 8.5, -115),
      draftkings: q("draftkings", "OVER", 8.5, -120),
      fanduel: q("fanduel", "OVER", 8.5, -122),
      betmgm: q("betmgm", "OVER", 8.5, -125),
      caesars: q("caesars", "OVER", 8.5, -118),
      espnbet: null,
      fanatics: q("fanatics", "OVER", 8.5, -130),
    },
  },
  {
    rowId: "row-judge-tb",
    player: { participantId: "mlb-judge", name: "Aaron Judge", team: "NYY", position: "RF" },
    event: { eventId: "mlb-402-nyy-bos", home: "BOS", away: "NYY", startInHours: 4 },
    statId: "TOTAL_BASES",
    side: "OVER",
    anchorLine: 1.5,
    fairHitProbability: 0.5488,
    consensusLine: 1.5,
    directionalLineEdge: 0.0,
    breakEven: 0.5,
    confidence: 0.78,
    score: 74,
    reason: "PRICE_GAP",
    flags: ["SAME_LINE_PRICE_GAP", "HIGH_HIT_PROBABILITY"],
    cells: {
      underdog: q("underdog", "OVER", 1.5, null, { multiplier: 1 }),
      sleeper: null,
      pinnacle: q("pinnacle", "OVER", 1.5, +105, { cellState: "best" }),
      circa: q("circa", "OVER", 1.5, +100),
      draftkings: q("draftkings", "OVER", 1.5, -110),
      fanduel: q("fanduel", "OVER", 1.5, -115),
      betmgm: q("betmgm", "OVER", 1.5, -108),
      caesars: q("caesars", "OVER", 1.5, -112),
      espnbet: q("espnbet", "OVER", 1.5, -110),
      fanatics: q("fanatics", "OVER", 1.5, -105),
    },
  },
  {
    rowId: "row-betts-hrr",
    player: { participantId: "mlb-betts", name: "Mookie Betts", team: "LAD", position: "SS" },
    event: { eventId: "mlb-403-lad-sf", home: "SF", away: "LAD", startInHours: 6 },
    statId: "HITS_RUNS_RBIS",
    side: "OVER",
    anchorLine: 2.5,
    fairHitProbability: 0.5205,
    consensusLine: 3.0,
    directionalLineEdge: 0.5,
    breakEven: 0.5,
    confidence: 0.71,
    score: 68,
    reason: "LINE_GAP",
    flags: ["FAVORABLE_LINE_GAP"],
    cells: {
      underdog: q("underdog", "OVER", 2.5, null, { multiplier: 1 }),
      sleeper: q("sleeper", "OVER", 2.5, null, { multiplier: 1 }),
      pinnacle: q("pinnacle", "OVER", 3.0, -105, { cellState: "best" }),
      circa: null,
      draftkings: q("draftkings", "OVER", 3.0, -110),
      fanduel: q("fanduel", "OVER", 3.0, -108),
      betmgm: q("betmgm", "OVER", 3.0, -115),
      caesars: q("caesars", "OVER", 3.0, -112),
      espnbet: null,
      fanatics: q("fanatics", "OVER", 3.0, -110),
    },
  },
  {
    rowId: "row-ohtani-hr",
    player: { participantId: "mlb-ohtani", name: "Shohei Ohtani", team: "LAD", position: "DH" },
    event: { eventId: "mlb-403-lad-sf", home: "SF", away: "LAD", startInHours: 6 },
    statId: "HOME_RUNS",
    side: "OVER",
    anchorLine: 0.5,
    anchorPromo: "demon",
    anchorMultiplier: 3,
    fairHitProbability: 0.4012,
    consensusLine: 0.5,
    directionalLineEdge: 0.0,
    breakEven: 0.5,
    confidence: 0.69,
    score: 55,
    reason: "PRICE_GAP",
    flags: ["PROMO_LINE"],
    cells: {
      underdog: q("underdog", "OVER", 0.5, null, { multiplier: 1 }),
      sleeper: q("sleeper", "OVER", 0.5, null, { multiplier: 1 }),
      pinnacle: q("pinnacle", "OVER", 0.5, +260, { cellState: "best" }),
      circa: q("circa", "OVER", 0.5, +270),
      draftkings: q("draftkings", "OVER", 0.5, +280),
      fanduel: q("fanduel", "OVER", 0.5, +275),
      betmgm: q("betmgm", "OVER", 0.5, +300),
      caesars: null,
      espnbet: q("espnbet", "OVER", 0.5, +290),
      fanatics: q("fanatics", "OVER", 0.5, +285),
    },
  },
  {
    rowId: "row-cole-ks",
    player: { participantId: "mlb-cole", name: "Gerrit Cole", team: "NYY", position: "SP" },
    event: { eventId: "mlb-402-nyy-bos", home: "BOS", away: "NYY", startInHours: 4 },
    statId: "PITCHER_STRIKEOUTS",
    side: "UNDER",
    anchorLine: 6.5,
    fairHitProbability: 0.5471,
    consensusLine: 6.0,
    directionalLineEdge: 0.5,
    breakEven: 0.5,
    confidence: 0.8,
    score: 79,
    reason: "LINE_GAP",
    flags: ["FAVORABLE_LINE_GAP", "STALE_QUOTE"],
    cells: {
      underdog: q("underdog", "UNDER", 6.5, null, { multiplier: 1 }),
      sleeper: q("sleeper", "UNDER", 6.5, null, { multiplier: 1 }),
      pinnacle: q("pinnacle", "UNDER", 6.0, -110, { cellState: "best" }),
      circa: q("circa", "UNDER", 6.0, -108),
      // Stale sportsbook quote — aged past the soft threshold.
      draftkings: q("draftkings", "UNDER", 6.0, -105, { observedAt: agoISO(240), cellState: "stale" }),
      fanduel: q("fanduel", "UNDER", 6.0, -112),
      betmgm: q("betmgm", "UNDER", 6.0, -110),
      caesars: q("caesars", "UNDER", 6.0, -115),
      espnbet: q("espnbet", "UNDER", 6.0, -110),
      fanatics: null,
    },
  },
  {
    rowId: "row-soto-hits",
    player: { participantId: "mlb-soto", name: "Juan Soto", team: "NYM", position: "RF" },
    event: { eventId: "mlb-404-nym-atl", home: "ATL", away: "NYM", startInHours: 5 },
    statId: "HITS",
    side: "OVER",
    anchorLine: 1.5,
    fairHitProbability: 0.4123,
    consensusLine: 1.5,
    directionalLineEdge: 0.0,
    breakEven: 0.5,
    confidence: 0.58,
    score: 33,
    reason: "INSUFFICIENT_DATA",
    flags: ["INSUFFICIENT_MARKET_DATA"],
    cells: {
      underdog: q("underdog", "OVER", 1.5, null, { multiplier: 1 }),
      sleeper: null,
      pinnacle: null,
      circa: null,
      draftkings: q("draftkings", "OVER", 1.5, +145),
      fanduel: null,
      betmgm: q("betmgm", "OVER", 1.5, +150),
      caesars: null,
      espnbet: null,
      fanatics: null,
    },
  },
  {
    rowId: "row-witt-sb",
    player: { participantId: "mlb-witt", name: "Bobby Witt Jr.", team: "KC", position: "SS" },
    event: { eventId: "mlb-405-kc-min", home: "MIN", away: "KC", startInHours: 7 },
    statId: "STOLEN_BASES",
    side: "OVER",
    anchorLine: 0.5,
    fairHitProbability: 0.4885,
    consensusLine: 0.5,
    directionalLineEdge: 0.0,
    breakEven: 0.5,
    confidence: 0.66,
    score: 47,
    reason: "PRICE_GAP",
    flags: ["MARKET_OUTLIER"],
    cells: {
      underdog: q("underdog", "OVER", 0.5, null, { multiplier: 1 }),
      sleeper: q("sleeper", "OVER", 0.5, null, { multiplier: 1 }),
      pinnacle: q("pinnacle", "OVER", 0.5, +120, { cellState: "best" }),
      circa: q("circa", "OVER", 0.5, +125),
      draftkings: q("draftkings", "OVER", 0.5, +130),
      // Outlier quote — diverges beyond the dispersion gate, excluded from consensus.
      fanduel: q("fanduel", "OVER", 0.5, +240, { cellState: "outlier" }),
      betmgm: q("betmgm", "OVER", 0.5, +135),
      caesars: q("caesars", "OVER", 0.5, +128),
      espnbet: null,
      fanatics: q("fanatics", "OVER", 0.5, +132),
    },
  },
  {
    rowId: "row-burnes-ha",
    player: { participantId: "mlb-burnes", name: "Corbin Burnes", team: "ARI", position: "SP" },
    event: { eventId: "mlb-406-ari-sd", home: "SD", away: "ARI", startInHours: 8 },
    statId: "HITS_ALLOWED",
    side: "UNDER",
    anchorLine: 5.5,
    fairHitProbability: 0.5312,
    consensusLine: 5.5,
    directionalLineEdge: 0.0,
    breakEven: 0.5,
    confidence: 0.74,
    score: 61,
    reason: "PRICE_GAP",
    flags: ["SAME_LINE_PRICE_GAP"],
    cells: {
      underdog: q("underdog", "UNDER", 5.5, null, { multiplier: 1 }),
      sleeper: q("sleeper", "UNDER", 5.5, null, { multiplier: 1 }),
      pinnacle: q("pinnacle", "UNDER", 5.5, -105, { cellState: "best" }),
      circa: q("circa", "UNDER", 5.5, -108),
      draftkings: q("draftkings", "UNDER", 5.5, -115),
      fanduel: q("fanduel", "UNDER", 5.5, -110),
      // Suspended market — dimmed, excluded from consensus.
      betmgm: q("betmgm", "UNDER", 5.5, -110, { available: false, cellState: "suspended" }),
      caesars: q("caesars", "UNDER", 5.5, -112),
      espnbet: q("espnbet", "UNDER", 5.5, -110),
      fanatics: q("fanatics", "UNDER", 5.5, -114),
    },
  },
  {
    rowId: "row-freeman-tb",
    player: { participantId: "mlb-freeman", name: "Freddie Freeman", team: "LAD", position: "1B" },
    event: { eventId: "mlb-403-lad-sf", home: "SF", away: "LAD", startInHours: 6 },
    statId: "TOTAL_BASES",
    side: "UNDER",
    anchorLine: 1.5,
    fairHitProbability: 0.4602,
    consensusLine: 1.5,
    directionalLineEdge: 0.0,
    breakEven: 0.5,
    confidence: 0.63,
    score: 29,
    reason: "INSUFFICIENT_DATA",
    flags: [],
    cells: {
      underdog: q("underdog", "UNDER", 1.5, null, { multiplier: 1 }),
      sleeper: q("sleeper", "UNDER", 1.5, null, { multiplier: 1 }),
      pinnacle: q("pinnacle", "UNDER", 1.5, -130),
      circa: null,
      draftkings: q("draftkings", "UNDER", 1.5, -140),
      fanduel: q("fanduel", "UNDER", 1.5, -135),
      betmgm: null,
      caesars: q("caesars", "UNDER", 1.5, -138),
      espnbet: null,
      fanatics: null,
    },
  },
];

function bestPriceFromCells(cells: Record<string, DisplayQuote | null>): ArbLegPick | null {
  let best: ArbLegPick | null = null;
  for (const c of Object.values(cells)) {
    if (!c || c.americanOdds == null) continue;
    const decimal = americanToDecimal(c.americanOdds);
    if (!best || decimal > best.decimal) {
      best = { bookId: c.bookId, american: c.americanOdds, decimal, impliedProb: americanToProbability(c.americanOdds), available: c.available };
    }
  }
  return best;
}

function specToRow(spec: RowSpec): PropsGridRow {
  const stat = getStatById(spec.statId)!;
  const startTime = new Date(Date.now() + spec.event.startInHours * 3600 * 1000).toISOString();
  const fair = spec.fairHitProbability;
  const anchor: DisplayQuote = {
    quoteId: `mock-anchor-${spec.rowId}`,
    bookId: MOCK_ANCHOR_BOOK_ID,
    side: spec.side,
    line: spec.anchorLine,
    americanOdds: null,
    multiplier: spec.anchorMultiplier ?? 1,
    promo: spec.anchorPromo ?? null,
    available: true,
    isMainLine: !spec.anchorPromo,
    observedAt: agoISO(15),
  };
  return {
    rowId: spec.rowId,
    player: {
      participantId: spec.player.participantId,
      name: spec.player.name,
      team: spec.player.team,
      position: spec.player.position,
      headshotUrl: null,
    },
    event: {
      eventId: spec.event.eventId,
      sport: "baseball",
      league: "mlb",
      homeTeam: spec.event.home,
      awayTeam: spec.event.away,
      startTime,
      matchupLabel: `${spec.event.away} @ ${spec.event.home}`,
    },
    stat,
    period: DEFAULT_PERIOD,
    side: spec.side,
    anchor,
    // Mock encodes one side per spec, so a true two-way arb can't be computed; show
    // the best price for the side and leave arb null (the live path fills both).
    arb: null,
    bestPrice: bestPriceFromCells(spec.cells),
    twoWayCells: Object.fromEntries(
      BOOKS.map((b) => {
        const c = spec.cells[b.bookId] ?? null;
        return [b.bookId, spec.side === "OVER" ? { over: c, under: null } : { over: null, under: c }];
      })
    ),
    fairHitProbability: fair,
    fairAmericanOdds: fair != null ? probabilityToAmerican(fair) : null,
    confidence: spec.confidence,
    discrepancy: {
      anchorLine: spec.anchorLine,
      consensusLine: spec.consensusLine,
      directionalLineEdge: spec.directionalLineEdge,
      lineZScore: spec.directionalLineEdge != null ? spec.directionalLineEdge / (stat.dispersionScale ?? 1) : null,
      marketHitProbability: fair,
      breakEvenProbability: spec.breakEven,
      probabilityEdge: fair != null && spec.breakEven != null ? Number((fair - spec.breakEven).toFixed(4)) : null,
      dispersion: 0.03,
      score: spec.score,
      reason: spec.reason,
    },
    cellsByBookId: spec.cells,
    flags: spec.flags,
    trace: {
      methodVersion: "mock-1",
      includedQuoteIds: Object.values(spec.cells)
        .filter((c): c is DisplayQuote => !!c && c.available && c.cellState !== "outlier")
        .map((c) => c.quoteId),
      rejectedQuoteIds: Object.values(spec.cells)
        .filter((c): c is DisplayQuote => !!c && (c.cellState === "outlier" || !c.available))
        .map((c) => ({ quoteId: c.quoteId, reason: c.available ? "MARKET_OUTLIER" : "HARD_STALE_QUOTE" })),
      thresholds: { minLineGap: 0.5, minConfidence: 0.65, minHitProbability: 0.52 },
      confidenceComponents: {
        exactLineCoverage: 0.6,
        bookCountScore: 0.8,
        freshnessScore: 0.9,
        identityScore: 1,
        dispersionScore: 0.7,
      },
    },
  };
}

export function getMockRows(): PropsGridRow[] {
  quoteSeq = 0;
  return SPECS.map(specToRow);
}

export const MOCK_HEALTH: ProviderHealth[] = [
  {
    providerId: "sportsgameodds",
    status: "healthy",
    lastSuccessAt: agoISO(8),
    latencyMs: 240,
    activeEvents: 9,
  },
];

export function getMockBooks(): BookSummary[] {
  return BOOKS;
}

export { DEFAULT_FILTERS };

export function getMockBootstrap(): PropsBootstrap {
  return {
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    rows: getMockRows(),
    books: getMockBooks(),
    health: MOCK_HEALTH,
    filters: DEFAULT_FILTERS,
    generatedAt: new Date().toISOString(),
  };
}
