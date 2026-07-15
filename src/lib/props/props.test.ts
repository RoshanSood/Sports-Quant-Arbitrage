import { describe, expect, it } from "vitest";
import {
  americanToProbability,
  devigTwoWay,
  directionalLineEdge,
  interpolateAtLine,
  probabilityToAmerican,
  weightedMedian,
} from "./oddsMath";
import { resolveProviderStat, resolveStat } from "./statRegistry";
import { normalizeBatch } from "./normalize";
import { materializeRows } from "./materialize";
import { computeTwoWayArb } from "./arb";
import type { RawProviderBatch, RawProviderQuote } from "./providers/types";

// ── oddsMath (manual §17–§20) ────────────────────────────────────────────────

describe("oddsMath", () => {
  it("converts American → probability both signs", () => {
    expect(americanToProbability(-110)).toBeCloseTo(0.5238, 3);
    expect(americanToProbability(+100)).toBeCloseTo(0.5, 3);
    expect(americanToProbability(+150)).toBeCloseTo(0.4, 3);
  });

  it("de-vigs a two-way pair to sum 1", () => {
    const { over, under } = devigTwoWay(americanToProbability(-110), americanToProbability(-110));
    expect(over + under).toBeCloseTo(1, 6);
    expect(over).toBeCloseTo(0.5, 6);
  });

  it("round-trips probability ↔ American near break-even", () => {
    const a = probabilityToAmerican(0.55);
    expect(americanToProbability(a)).toBeCloseTo(0.55, 2);
  });

  it("directional line edge is positive when the anchor line is easier", () => {
    // OVER 7.5 vs consensus 8.5 → anchor easier by 1.0
    expect(directionalLineEdge("OVER", 7.5, 8.5)).toBeCloseTo(1, 6);
    // UNDER 30.5 vs consensus 29.0 → anchor easier by 1.5
    expect(directionalLineEdge("UNDER", 30.5, 29.0)).toBeCloseTo(1.5, 6);
    // UNDER 15.5 vs consensus 16.5 → harder (negative)
    expect(directionalLineEdge("UNDER", 15.5, 16.5)).toBeCloseTo(-1, 6);
  });

  it("interpolates in logit space between bracketing lines", () => {
    const points = [
      { line: 7.5, probability: 0.6 },
      { line: 8.5, probability: 0.45 },
    ];
    const est = interpolateAtLine(points, 8.0, "OVER", 0.5);
    expect(est).not.toBeNull();
    expect(est!.probability).toBeGreaterThan(0.45);
    expect(est!.probability).toBeLessThan(0.6);
    expect(est!.confidenceMultiplier).toBe(0.85);
  });

  it("weighted median resists a low-weight outlier", () => {
    const m = weightedMedian([
      { value: 8.5, weight: 1 },
      { value: 8.5, weight: 1 },
      { value: 12.5, weight: 0.05 },
    ]);
    expect(m).toBe(8.5);
  });
});

// ── registry ─────────────────────────────────────────────────────────────────

describe("stat registry", () => {
  it("resolves provider statIDs to canonical MLB stats", () => {
    expect(resolveProviderStat("pitching_strikeouts")?.id).toBe("PITCHER_STRIKEOUTS");
    expect(resolveProviderStat("batting_totalBases")?.id).toBe("TOTAL_BASES");
    expect(resolveProviderStat("batting_hits+runs+rbi")?.id).toBe("HITS_RUNS_RBIS");
    expect(resolveProviderStat("nonsense_stat")).toBeNull();
  });

  it("resolves display aliases", () => {
    expect(resolveStat("Pitcher Ks")?.id).toBe("PITCHER_STRIKEOUTS");
  });
});

// ── end-to-end normalize → materialize (manual §14–§21) ──────────────────────

function q(bookId: string, side: "over" | "under", line: number, odds: number | null): RawProviderQuote {
  return {
    oddID: `pitching_strikeouts-SKUBAL-game-ou-${side}`,
    statID: "pitching_strikeouts",
    statEntityID: "SKUBAL",
    periodID: "game",
    betTypeID: "ou",
    sideID: side,
    bookId,
    line,
    americanOdds: odds,
    available: true,
    sourceUpdatedAt: null,
  };
}

function sampleBatch(): RawProviderBatch {
  const now = new Date().toISOString();
  return {
    providerId: "sportsgameodds",
    fetchedAt: now,
    latencyMs: 100,
    events: [
      {
        eventId: "evt1",
        leagueId: "MLB",
        sportId: "BASEBALL",
        startTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
        home: { teamId: "CLE", name: "Guardians", abbreviation: "CLE" },
        away: { teamId: "DET", name: "Tigers", abbreviation: "DET" },
        players: { SKUBAL: { participantId: "SKUBAL", name: "Tarik Skubal", team: "DET", position: "SP" } },
        quotes: [
          // All books at 7.5 with varied prices → a real cross-book arb: best over is
          // FanDuel +110, best under is DraftKings -105 (implieds sum < 100%).
          q("draftkings", "over", 7.5, -115),
          q("draftkings", "under", 7.5, -105),
          q("fanduel", "over", 7.5, +110),
          q("fanduel", "under", 7.5, -130),
          q("betmgm", "over", 7.5, -105),
          q("betmgm", "under", 7.5, -115),
          q("pinnacle", "over", 7.5, +105),
          q("pinnacle", "under", 7.5, -125),
        ],
      },
    ],
  };
}

// A game/team-scope total (statEntityID home/away/all) — must be dropped.
function teamTotalQuote(): RawProviderQuote {
  return {
    oddID: "points-home-game-ou-over",
    statID: "points",
    statEntityID: "home",
    periodID: "game",
    betTypeID: "ou",
    sideID: "over",
    bookId: "draftkings",
    line: 4.5,
    americanOdds: -110,
    available: true,
    sourceUpdatedAt: null,
  };
}

describe("pipeline: normalize + materialize", () => {
  it("keeps ou player props and drops team/game totals", () => {
    const batch = sampleBatch();
    batch.events[0].quotes.push(teamTotalQuote());
    const { quotes, rejects } = normalizeBatch(batch);
    expect(quotes.length).toBe(8); // team total excluded
    expect(rejects).toBe(1);
    expect(quotes.every((q) => q.player.participantId === "SKUBAL")).toBe(true);
  });

  it("emits one two-way row with the arb legs and BET highlights", () => {
    const { quotes } = normalizeBatch(sampleBatch());
    const rows = materializeRows(quotes, Date.now());
    expect(rows.length).toBe(1); // one true-arb row per prop (not per side)
    const r = rows[0];
    expect(r.player.name).toBe("Tarik Skubal");
    expect(r.anchor.line).toBe(7.5);
    // Cross-book arb: best over (FD +110) + best under (DK -105) imply < 100%.
    expect(r.arb?.isArb).toBe(true);
    expect(r.arb?.edgePct ?? 0).toBeGreaterThan(0);
    expect(r.arb?.over?.bookId).toBe("fanduel");
    expect(r.arb?.over?.american).toBe(110);
    expect(r.arb?.under?.bookId).toBe("draftkings");
    // The two books to BET are highlighted: FanDuel's over cell + DraftKings's under.
    expect(r.twoWayCells.fanduel.over?.cellState).toBe("best");
    expect(r.twoWayCells.draftkings.under?.cellState).toBe("best");
    // Both sides present per book (two-way cells).
    expect(r.twoWayCells.betmgm.over?.americanOdds).toBe(-105);
    expect(r.twoWayCells.betmgm.under?.americanOdds).toBe(-115);
  });
});

describe("computeTwoWayArb", () => {
  it("locks an arb when best over + best under imply under 100%", () => {
    const arb = computeTwoWayArb(
      [
        { bookId: "fd", american: 110, available: true },
        { bookId: "dk", american: -115, available: true },
      ],
      [
        { bookId: "dk", american: -105, available: true },
        { bookId: "mgm", american: -130, available: true },
      ],
      7.5
    );
    expect(arb.over?.bookId).toBe("fd");
    expect(arb.under?.bookId).toBe("dk");
    expect(arb.isArb).toBe(true);
    expect(arb.edgePct ?? 0).toBeGreaterThan(0);
    expect(arb.stake).not.toBeNull();
  });

  it("reports a positive hold when there's no arb", () => {
    const arb = computeTwoWayArb(
      [{ bookId: "fd", american: -110, available: true }],
      [{ bookId: "dk", american: -110, available: true }],
      1.5
    );
    expect(arb.isArb).toBe(false);
    expect(arb.holdPct ?? 0).toBeGreaterThan(0);
  });

  it("does not treat unavailable prices as executable arb legs", () => {
    const arb = computeTwoWayArb(
      [{ bookId: "fd", american: 250, available: false }],
      [{ bookId: "dk", american: 250, available: false }],
      1.5
    );
    expect(arb.isArb).toBe(false);
    expect(arb.bothAvailable).toBe(false);
    expect(arb.stake).toBeNull();
  });
});
