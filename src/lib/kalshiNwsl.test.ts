import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArbGame } from "./arbitrage/sports";

const kalshiGetMock = vi.hoisted(() => vi.fn());

vi.mock("./kalshiAuth", () => ({ kalshiGet: kalshiGetMock }));

import { fetchKalshiThreeWayMoneylineByGame } from "./kalshi";

const game: ArbGame = {
  id: "401853969",
  date: "2026-08-14",
  awayTeam: { name: "Kansas City Current", shortName: "Kansas City", abbreviation: "KC" },
  homeTeam: { name: "Gotham FC", shortName: "Gotham", abbreviation: "GFC" },
};

function market(ticker: string, team: string, ask: string) {
  return {
    ticker,
    event_ticker: "KXNWSLGAME-26AUG14GOTKC",
    title: `${team} wins Gotham FC vs Kansas City Current`,
    yes_sub_title: team,
    status: "open",
    yes_bid_dollars: String(Number(ask) - 0.01),
    yes_ask_dollars: ask,
    yes_ask_size_fp: 100,
  };
}

describe("Kalshi NWSL 1X2 normalization", () => {
  beforeEach(() => {
    kalshiGetMock.mockReset();
  });

  it("reads home, away, and draw from their independent YES contracts", async () => {
    kalshiGetMock.mockResolvedValue({
      events: [{
        event_ticker: "KXNWSLGAME-26AUG14GOTKC",
        title: "Gotham FC vs Kansas City Current",
        markets: [
          market("KXNWSLGAME-26AUG14GOTKC-GOT", "Gotham FC", "0.46"),
          market("KXNWSLGAME-26AUG14GOTKC-KC", "Kansas City Current", "0.31"),
          market("KXNWSLGAME-26AUG14GOTKC-TIE", "Tie", "0.27"),
        ],
      }],
    });

    const quote = (await fetchKalshiThreeWayMoneylineByGame([game], "KXNWSLGAME")).get(game.id);
    expect(quote).toMatchObject({
      homeCents: 46,
      awayCents: 31,
      drawCents: 27,
      homeTokenId: "KXNWSLGAME-26AUG14GOTKC-GOT",
      awayTokenId: "KXNWSLGAME-26AUG14GOTKC-KC",
      drawTokenId: "KXNWSLGAME-26AUG14GOTKC-TIE",
      sourceStartTime: "2026-08-14",
    });
  });

  it("rejects an incomplete soccer market instead of treating it as two-way", async () => {
    kalshiGetMock.mockResolvedValue({
      events: [{
        event_ticker: "KXNWSLGAME-26AUG14GOTKC",
        title: "Gotham FC vs Kansas City Current",
        markets: [
          market("KXNWSLGAME-26AUG14GOTKC-GOT", "Gotham FC", "0.46"),
          market("KXNWSLGAME-26AUG14GOTKC-KC", "Kansas City Current", "0.31"),
        ],
      }],
    });

    expect(await fetchKalshiThreeWayMoneylineByGame([game], "KXNWSLGAME")).toEqual(new Map());
  });
});
