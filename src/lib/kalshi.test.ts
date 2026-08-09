import { describe, expect, it } from "vitest";
import { eventMatchesTennisGame, lastNameOf } from "./kalshi";
import type { ArbGame } from "./arbitrage/sports";

function player(name: string): ArbGame["awayTeam"] {
  return { name, shortName: name, abbreviation: name.slice(0, 3).toUpperCase() };
}

function game(away: string, home: string, date = "2026-08-09"): ArbGame {
  return { id: "g1", date, awayTeam: player(away), homeTeam: player(home) };
}

describe("kalshi.ts — lastNameOf", () => {
  it("takes the final whitespace-separated token", () => {
    expect(lastNameOf("Liudmila Samsonova")).toBe("Samsonova");
    expect(lastNameOf("Elena Rybakina")).toBe("Rybakina");
  });

  it("handles multi-word surnames by taking only the final token", () => {
    expect(lastNameOf("Marina Bassols Ribera")).toBe("Ribera");
  });

  it("returns the whole string when there's no space", () => {
    expect(lastNameOf("Cher")).toBe("Cher");
  });
});

// Fixtures match Kalshi's REAL event shape, live-verified 2026-08-09 against
// KXWTAMATCH-26AUG09SAMRYB: event title/sub_title carry only last names
// ("Samsonova vs Rybakina"), unlike team-sport events which carry full names/cities.
describe("kalshi.ts — eventMatchesTennisGame", () => {
  const event = (title: string, ticker = "KXWTAMATCH-26AUG09SAMRYB") => ({
    event_ticker: ticker,
    title,
    sub_title: `${title} (Aug 9)`,
  });

  it("matches when both players' last names appear in the event text", () => {
    const g = game("Liudmila Samsonova", "Elena Rybakina");
    expect(eventMatchesTennisGame(g, event("Samsonova vs Rybakina"))).toBe(true);
  });

  it("does not match when only one player's last name is present", () => {
    const g = game("Liudmila Samsonova", "Coco Gauff");
    expect(eventMatchesTennisGame(g, event("Samsonova vs Rybakina"))).toBe(false);
  });

  it("does not match a different day's event even with matching names", () => {
    // Live-verified real case: Alexandrova vs Svitolina was listed under 26AUG10 (tomorrow)
    // while the ESPN game requested was for today (2026-08-09) — must not cross-match.
    const g = game("Ekaterina Alexandrova", "Elina Svitolina", "2026-08-09");
    const tomorrowEvent = event("Alexandrova vs Svitolina", "KXWTAMATCH-26AUG10ALESVI");
    expect(eventMatchesTennisGame(g, tomorrowEvent)).toBe(false);
  });

  it("rejects a placeholder/unresolved opponent rather than false-matching", () => {
    // Live-verified real case: ESPN briefly listed "Elena Rybakina v TBD" — must never
    // match "TBD" against a real surname just because it clears the length floor... TBD is
    // exactly 3 chars, so this specifically checks it doesn't appear in real match text.
    const g = game("Elena Rybakina", "TBD");
    expect(eventMatchesTennisGame(g, event("Samsonova vs Rybakina"))).toBe(false);
  });

  it("returns false for an empty event", () => {
    expect(eventMatchesTennisGame(game("A Player", "B Player"), { event_ticker: "x" })).toBe(false);
  });
});
