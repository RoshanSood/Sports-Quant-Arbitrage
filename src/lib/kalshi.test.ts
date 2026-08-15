import { afterEach, describe, expect, it, vi } from "vitest";
import { eventMatchesTennisGame, fetchKalshiIndependentMoneylineByGame, lastNameOf } from "./kalshi";
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

describe("kalshi.ts — independent team moneylines", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads each team's own YES ask and native ticker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      events: [{
        event_ticker: "KXNFLGAME-26AUG13DETCIN",
        title: "Detroit vs Cincinnati",
        sub_title: "DET vs CIN (Aug 13)",
        markets: [
          {
            ticker: "KXNFLGAME-26AUG13DETCIN-CIN",
            status: "active",
            yes_sub_title: "Cincinnati",
            yes_bid_dollars: "0.71",
            yes_ask_dollars: "0.72",
            yes_ask_size_fp: 50,
          },
          {
            ticker: "KXNFLGAME-26AUG13DETCIN-DET",
            status: "active",
            yes_sub_title: "Detroit",
            yes_bid_dollars: "0.28",
            yes_ask_dollars: "0.29",
            yes_ask_size_fp: 40,
          },
        ],
      }, {
        event_ticker: "KXNFLGAME-26AUG13GBPIT",
        title: "Green Bay vs Pittsburgh",
        sub_title: "GB vs PIT (Aug 13)",
        markets: [
          {
            ticker: "KXNFLGAME-26AUG13GBPIT-PIT",
            status: "active",
            yes_sub_title: "Pittsburgh",
            yes_bid_dollars: "0.48",
            yes_ask_dollars: "0.50",
          },
          {
            ticker: "KXNFLGAME-26AUG13GBPIT-GB",
            status: "active",
            yes_sub_title: "Green Bay",
            yes_bid_dollars: "0.50",
            yes_ask_dollars: "0.52",
          },
        ],
      }],
    }), { status: 200 })));

    const nflGame: ArbGame = {
      id: "401873272",
      date: "2026-08-13",
      awayTeam: { name: "Detroit Lions", shortName: "Lions", abbreviation: "DET" },
      homeTeam: { name: "Cincinnati Bengals", shortName: "Bengals", abbreviation: "CIN" },
    };
    const twoLetterAbbreviationGame: ArbGame = {
      id: "401873275",
      date: "2026-08-13",
      awayTeam: { name: "Green Bay Packers", shortName: "Packers", abbreviation: "GB" },
      homeTeam: { name: "Pittsburgh Steelers", shortName: "Steelers", abbreviation: "PIT" },
    };
    const result = await fetchKalshiIndependentMoneylineByGame(
      [nflGame, twoLetterAbbreviationGame],
      "KXNFLGAME"
    );

    expect(result.get(nflGame.id)).toMatchObject({
      awayCents: 29,
      homeCents: 72,
      awayTokenId: "KXNFLGAME-26AUG13DETCIN-DET",
      homeTokenId: "KXNFLGAME-26AUG13DETCIN-CIN",
      sourceStartTime: "2026-08-13",
    });
    expect(result.get(twoLetterAbbreviationGame.id)).toMatchObject({
      awayCents: 52,
      homeCents: 50,
      awayTokenId: "KXNFLGAME-26AUG13GBPIT-GB",
      homeTokenId: "KXNFLGAME-26AUG13GBPIT-PIT",
    });
  });
});
