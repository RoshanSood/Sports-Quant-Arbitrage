import { describe, expect, it } from "vitest";
import { parseNbaSummerScoreboard } from "./nbaSummerEspn";

describe("NBA Summer League ESPN schedule", () => {
  it("keeps the canonical matchup and exact start time", () => {
    const games = parseNbaSummerScoreboard(
      {
        events: [
          {
            id: "401800001",
            date: "2026-07-17T22:00Z",
            status: { type: { description: "Scheduled" } },
            competitions: [
              {
                competitors: [
                  {
                    homeAway: "home",
                    team: {
                      displayName: "Charlotte Hornets",
                      shortDisplayName: "Hornets",
                      abbreviation: "CHA",
                    },
                  },
                  {
                    homeAway: "away",
                    team: {
                      displayName: "Sacramento Kings",
                      shortDisplayName: "Kings",
                      abbreviation: "SAC",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      "2026-07-17"
    );

    expect(games).toEqual([
      {
        id: "nba-summer-401800001",
        date: "2026-07-17",
        startTimeIso: "2026-07-17T22:00Z",
        status: "Scheduled",
        awayTeam: {
          name: "Sacramento Kings",
          shortName: "Kings",
          abbreviation: "SAC",
        },
        homeTeam: {
          name: "Charlotte Hornets",
          shortName: "Hornets",
          abbreviation: "CHA",
        },
      },
    ]);
  });

  it("drops incomplete events instead of creating ambiguous games", () => {
    const games = parseNbaSummerScoreboard(
      {
        events: [
          {
            id: "missing-home-team",
            date: "2026-07-17T22:00Z",
            competitions: [
              {
                competitors: [
                  {
                    homeAway: "away",
                    team: { displayName: "Sacramento Kings" },
                  },
                ],
              },
            ],
          },
        ],
      },
      "2026-07-17"
    );

    expect(games).toEqual([]);
  });
});
