import { describe, expect, it } from "vitest";
import {
  normalizeTeamName,
  resolveTwoWayTeamOrder,
  teamsMatch,
  type TeamIdentity,
} from "./teamNormalization";

const NFL_TEAMS: Array<[full: string, nickname: string, abbreviation: string]> = [
  ["Arizona Cardinals", "Cardinals", "ARI"],
  ["Atlanta Falcons", "Falcons", "ATL"],
  ["Baltimore Ravens", "Ravens", "BAL"],
  ["Buffalo Bills", "Bills", "BUF"],
  ["Carolina Panthers", "Panthers", "CAR"],
  ["Chicago Bears", "Bears", "CHI"],
  ["Cincinnati Bengals", "Bengals", "CIN"],
  ["Cleveland Browns", "Browns", "CLE"],
  ["Dallas Cowboys", "Cowboys", "DAL"],
  ["Denver Broncos", "Broncos", "DEN"],
  ["Detroit Lions", "Lions", "DET"],
  ["Green Bay Packers", "Packers", "GB"],
  ["Houston Texans", "Texans", "HOU"],
  ["Indianapolis Colts", "Colts", "IND"],
  ["Jacksonville Jaguars", "Jaguars", "JAX"],
  ["Kansas City Chiefs", "Chiefs", "KC"],
  ["Las Vegas Raiders", "Raiders", "LV"],
  ["Los Angeles Chargers", "Chargers", "LAC"],
  ["Los Angeles Rams", "Rams", "LAR"],
  ["Miami Dolphins", "Dolphins", "MIA"],
  ["Minnesota Vikings", "Vikings", "MIN"],
  ["New England Patriots", "Patriots", "NE"],
  ["New Orleans Saints", "Saints", "NO"],
  ["New York Giants", "Giants", "NYG"],
  ["New York Jets", "Jets", "NYJ"],
  ["Philadelphia Eagles", "Eagles", "PHI"],
  ["Pittsburgh Steelers", "Steelers", "PIT"],
  ["San Francisco 49ers", "49ers", "SF"],
  ["Seattle Seahawks", "Seahawks", "SEA"],
  ["Tampa Bay Buccaneers", "Buccaneers", "TB"],
  ["Tennessee Titans", "Titans", "TEN"],
  ["Washington Commanders", "Commanders", "WAS"],
];

describe("NFL team normalization", () => {
  it.each(NFL_TEAMS)("keeps %s in its own sport identity", (full, nickname) => {
    expect(normalizeTeamName(full)).toBe(full.toLowerCase());
    expect(normalizeTeamName(full, "football")).toBe(full.toLowerCase());
    expect(normalizeTeamName(nickname, "football")).toBe(full.toLowerCase());
    expect(teamsMatch(nickname, full)).toBe(true);
    expect(teamsMatch(full, nickname)).toBe(true);
  });

  it("does not capture NFL cities with MLB aliases", () => {
    expect(normalizeTeamName("Miami Dolphins")).not.toBe("miami marlins");
    expect(normalizeTeamName("Washington Commanders")).not.toBe("washington nationals");
    expect(normalizeTeamName("Arizona Cardinals")).not.toBe("arizona diamondbacks");
    expect(normalizeTeamName("Pittsburgh Steelers")).not.toBe("pittsburgh pirates");
    expect(normalizeTeamName("San Francisco 49ers")).not.toBe("san francisco giants");
  });
});

describe("two-way native outcome mapping", () => {
  const dolphins: TeamIdentity = { name: "Miami Dolphins", shortName: "Dolphins", abbreviation: "MIA" };
  const commanders: TeamIdentity = { name: "Washington Commanders", shortName: "Commanders", abbreviation: "WAS" };

  it("maps the real Polymarket Dolphins/Commanders order without inversion", () => {
    expect(resolveTwoWayTeamOrder(["Dolphins", "Commanders"], dolphins, commanders)).toBe("away_home");
    expect(resolveTwoWayTeamOrder(["Commanders", "Dolphins"], dolphins, commanders)).toBe("home_away");
  });

  it("supports venue abbreviations but rejects ambiguous labels", () => {
    expect(resolveTwoWayTeamOrder(["MIA", "WAS"], dolphins, commanders)).toBe("away_home");
    expect(resolveTwoWayTeamOrder(["Yes", "No"], dolphins, commanders)).toBeNull();
    expect(resolveTwoWayTeamOrder(["Dolphins", "Dolphins"], dolphins, commanders)).toBeNull();
  });
});
