// Maps common short/nickname forms to canonical full names
export const TEAM_ALIASES: Record<string, string> = {
  // NWSL. Keep venue-specific full names explicit so city-only MLB aliases such as
  // "boston", "chicago", "houston", and "washington" cannot capture these clubs.
  "boston legacy fc": "boston legacy fc",
  "boston legacy women": "boston legacy fc",
  "portland thorns": "portland thorns fc",
  "portland thorns fc": "portland thorns fc",
  "portland thorns fc (w)": "portland thorns fc",
  "chicago stars fc": "chicago stars fc",
  "chicago red stars": "chicago stars fc",
  "chicago red stars (w)": "chicago stars fc",
  "bay fc": "bay fc",
  "bay fc (w)": "bay fc",
  "seattle reign": "seattle reign fc",
  "seattle reign fc": "seattle reign fc",
  "ol reign": "seattle reign fc",
  "ol reign (w)": "seattle reign fc",
  "angel city": "angel city fc",
  "angel city fc": "angel city fc",
  "angel city fc (w)": "angel city fc",
  "gotham": "gotham fc",
  "gotham fc": "gotham fc",
  "gotham fc (w)": "gotham fc",
  "sky blue fc": "gotham fc",
  "kansas city current": "kansas city current",
  "kansas city nwsl": "kansas city current",
  "kansas city nwsl (w)": "kansas city current",
  "san diego wave": "san diego wave fc",
  "san diego wave fc": "san diego wave fc",
  "san diego wave fc (w)": "san diego wave fc",
  "denver summit fc": "denver summit fc",
  "denver summit women": "denver summit fc",
  "utah royals": "utah royals",
  "utah royals fc": "utah royals",
  "racing louisville": "racing louisville fc",
  "racing louisville fc": "racing louisville fc",
  "racing louisville fc (w)": "racing louisville fc",
  "orlando pride": "orlando pride",
  "orlando pride (w)": "orlando pride",
  "north carolina courage": "north carolina courage",
  "north carolina courage (w)": "north carolina courage",
  "houston dash": "houston dash",
  "houston dash (w)": "houston dash",
  "washington spirit": "washington spirit",
  "washington spirit (w)": "washington spirit",
  // AL East
  "yankees": "new york yankees",
  "ny yankees": "new york yankees",
  "new york yankees": "new york yankees",
  "red sox": "boston red sox",
  "boston": "boston red sox",
  "boston red sox": "boston red sox",
  "rays": "tampa bay rays",
  "tampa bay": "tampa bay rays",
  "tampa bay rays": "tampa bay rays",
  "blue jays": "toronto blue jays",
  "toronto": "toronto blue jays",
  "jays": "toronto blue jays",
  "toronto blue jays": "toronto blue jays",
  "orioles": "baltimore orioles",
  "baltimore": "baltimore orioles",
  "baltimore orioles": "baltimore orioles",
  // AL Central
  "white sox": "chicago white sox",
  "chicago white sox": "chicago white sox",
  "guardians": "cleveland guardians",
  "cleveland": "cleveland guardians",
  "cleveland guardians": "cleveland guardians",
  "tigers": "detroit tigers",
  "detroit": "detroit tigers",
  "detroit tigers": "detroit tigers",
  "royals": "kansas city royals",
  "kansas city": "kansas city royals",
  "kansas city royals": "kansas city royals",
  "twins": "minnesota twins",
  "minnesota": "minnesota twins",
  "minnesota twins": "minnesota twins",
  // AL West
  "astros": "houston astros",
  "houston": "houston astros",
  "houston astros": "houston astros",
  "angels": "los angeles angels",
  "la angels": "los angeles angels",
  "laa": "los angeles angels",
  "los angeles angels": "los angeles angels",
  "athletics": "oakland athletics",
  "oakland": "oakland athletics",
  "oakland athletics": "oakland athletics",
  // Note: avoid "as" alias — too short, false-positive on "Texas", "Kansas", etc.
  "mariners": "seattle mariners",
  "seattle": "seattle mariners",
  "seattle mariners": "seattle mariners",
  "rangers": "texas rangers",
  "texas": "texas rangers",
  "texas rangers": "texas rangers",
  // NL East
  "braves": "atlanta braves",
  "atlanta": "atlanta braves",
  "atlanta braves": "atlanta braves",
  "marlins": "miami marlins",
  "miami": "miami marlins",
  "miami marlins": "miami marlins",
  "mets": "new york mets",
  "ny mets": "new york mets",
  "new york mets": "new york mets",
  "phillies": "philadelphia phillies",
  "philadelphia": "philadelphia phillies",
  "philadelphia phillies": "philadelphia phillies",
  "nationals": "washington nationals",
  "washington": "washington nationals",
  "nats": "washington nationals",
  "washington nationals": "washington nationals",
  // NL Central
  "cubs": "chicago cubs",
  "chicago cubs": "chicago cubs",
  "reds": "cincinnati reds",
  "cincinnati": "cincinnati reds",
  "cincinnati reds": "cincinnati reds",
  "rockies": "colorado rockies",
  "colorado": "colorado rockies",
  "colorado rockies": "colorado rockies",
  "brewers": "milwaukee brewers",
  "milwaukee": "milwaukee brewers",
  "milwaukee brewers": "milwaukee brewers",
  "pirates": "pittsburgh pirates",
  "pittsburgh": "pittsburgh pirates",
  "pittsburgh pirates": "pittsburgh pirates",
  "cardinals": "st. louis cardinals",
  "st louis": "st. louis cardinals",
  "stl": "st. louis cardinals",
  "st. louis cardinals": "st. louis cardinals",
  // NL West
  "diamondbacks": "arizona diamondbacks",
  "arizona": "arizona diamondbacks",
  "d-backs": "arizona diamondbacks",
  "dbacks": "arizona diamondbacks",
  "arizona diamondbacks": "arizona diamondbacks",
  "dodgers": "los angeles dodgers",
  "la dodgers": "los angeles dodgers",
  "lad": "los angeles dodgers",
  "los angeles dodgers": "los angeles dodgers",
  "padres": "san diego padres",
  "san diego": "san diego padres",
  "san diego padres": "san diego padres",
  "giants": "san francisco giants",
  "san francisco": "san francisco giants",
  "sf giants": "san francisco giants",
  "san francisco giants": "san francisco giants",
  // Kalshi uses single-letter city disambiguation for teams sharing a city
  "new york y": "new york yankees",
  "new york m": "new york mets",
  "los angeles d": "los angeles dodgers",
  "los angeles a": "los angeles angels",
  "chicago c": "chicago cubs",
  "chicago w": "chicago white sox",
};

const NFL_TEAM_ROWS = [
  ["arizona cardinals", "cardinals", "ari"], ["atlanta falcons", "falcons", "atl"],
  ["baltimore ravens", "ravens", "bal"], ["buffalo bills", "bills", "buf"],
  ["carolina panthers", "panthers", "car"], ["chicago bears", "bears", "chi"],
  ["cincinnati bengals", "bengals", "cin"], ["cleveland browns", "browns", "cle"],
  ["dallas cowboys", "cowboys", "dal"], ["denver broncos", "broncos", "den"],
  ["detroit lions", "lions", "det"], ["green bay packers", "packers", "gb"],
  ["houston texans", "texans", "hou"], ["indianapolis colts", "colts", "ind"],
  ["jacksonville jaguars", "jaguars", "jax"], ["kansas city chiefs", "chiefs", "kc"],
  ["las vegas raiders", "raiders", "lv"], ["los angeles chargers", "chargers", "lac"],
  ["los angeles rams", "rams", "lar"], ["miami dolphins", "dolphins", "mia"],
  ["minnesota vikings", "vikings", "min"], ["new england patriots", "patriots", "ne"],
  ["new orleans saints", "saints", "no"], ["new york giants", "giants", "nyg"],
  ["new york jets", "jets", "nyj"], ["philadelphia eagles", "eagles", "phi"],
  ["pittsburgh steelers", "steelers", "pit"], ["san francisco 49ers", "49ers", "sf"],
  ["seattle seahawks", "seahawks", "sea"], ["tampa bay buccaneers", "buccaneers", "tb"],
  ["tennessee titans", "titans", "ten"], ["washington commanders", "commanders", "was"],
] as const;

export const NFL_TEAM_ALIASES: Record<string, string> = Object.fromEntries(
  NFL_TEAM_ROWS.flatMap(([canonical, nickname, abbreviation]) => [
    [canonical, canonical],
    [nickname, canonical],
    [abbreviation, canonical],
  ])
);

// Returns the canonical full name for a SINGLE team name/abbreviation.
// NEVER pass a full event title (e.g. "Angels vs. Blue Jays") — that will match the wrong team.
export function normalizeTeamName(name: string, sport?: string): string {
  const lower = name.toLowerCase().replace(/\s+/g, " ").trim();
  if (sport === "football") return NFL_TEAM_ALIASES[lower] ?? lower;
  if (TEAM_ALIASES[lower]) return TEAM_ALIASES[lower];
  // `name` is a single team label, not an event title. Do not use substring aliases
  // here: city-only MLB aliases such as "miami", "washington", "arizona" and
  // "pittsburgh" also occur in NFL team names. Substring matching turned
  // "Miami Dolphins" into "Miami Marlins" and inverted venue outcome tokens.
  // Decorated venue/event titles are handled separately by teamMatchesTitle().
  return lower;
}

// Check whether a single team (identified by ESPN name, short name, abbreviation)
// appears anywhere in a Polymarket event title.
// This does substring checks, NOT normalizeTeamName on the full title.
export function teamMatchesTitle(
  espnName: string,
  espnShortName: string,
  espnAbbr: string,
  title: string
): boolean {
  const lower = title.toLowerCase();

  // Direct substring: full ESPN name (e.g. "Los Angeles Angels")
  if (lower.includes(espnName.toLowerCase())) return true;
  // Short name (e.g. "Angels")
  if (lower.includes(espnShortName.toLowerCase())) return true;

  // Some Kalshi team labels use only the location ("Green Bay") or the location
  // plus a nickname initial ("Los Angeles C"). Restrict this to the entire label so
  // same-city teams do not both match a longer event title.
  const full = espnName.toLowerCase().trim();
  const short = espnShortName.toLowerCase().trim();
  const location = full.endsWith(` ${short}`) ? full.slice(0, -(short.length + 1)) : "";
  const normalizedLabel = lower.replace(/[^a-z0-9]+/g, " ").trim();
  if (location && (
    normalizedLabel === location ||
    normalizedLabel === `${location} ${short.charAt(0)}`
  )) return true;

  // All known aliases for this team's canonical name
  const canonical = normalizeTeamName(espnName);
  for (const [alias, can] of Object.entries(TEAM_ALIASES)) {
    if (can === canonical && lower.includes(alias)) return true;
  }

  // Token-bounded abbreviation check. NFL uses two-letter abbreviations such as GB,
  // NE, LV, and SF, which are safe here only as complete tokens (never substrings).
  const abbr = espnAbbr.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (abbr.length >= 2) {
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(lower)) return true;
  }

  return false;
}

// Legacy helper kept for backward compatibility in other modules (spread/moneyline labeling)
export function teamsMatch(name1: string, name2: string): boolean {
  // Prefer the literal single-team labels before consulting league aliases. This makes
  // "Dolphins" match "Miami Dolphins", "Cardinals" match "Arizona Cardinals", and
  // "Giants" match "New York Giants" without allowing MLB canonicalization to steal
  // those NFL nicknames.
  const raw1 = name1.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const raw2 = name2.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (raw1 && raw2 && (raw1 === raw2 || raw1.includes(raw2) || raw2.includes(raw1))) return true;
  const n1 = normalizeTeamName(name1);
  const n2 = normalizeTeamName(name2);
  if (n1 === n2) return true;
  if (n1.includes(n2) || n2.includes(n1)) return true;
  return false;
}

export type TeamIdentity = {
  name: string;
  shortName: string;
  abbreviation: string;
};

// Match a single venue outcome label to one canonical fixture team. This is deliberately
// separate from title matching: outcome labels must identify exactly one side, so an
// ambiguous or unknown label must fail closed instead of being assigned to "the other"
// team by elimination.
export function teamLabelMatches(label: string, team: TeamIdentity): boolean {
  if (teamsMatch(label, team.name) || teamsMatch(label, team.shortName)) return true;
  const normalizedLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const abbr = team.abbreviation.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (abbr.length < 2) return false;
  const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalizedLabel);
}

export type TwoWayTeamOrder = "away_home" | "home_away";

// Resolve the native outcome order only when both labels independently identify opposite
// fixture teams. Callers must drop the market on null; guessing the second side is what
// created the Dolphins/Commanders same-outcome "arb".
export function resolveTwoWayTeamOrder(
  labels: readonly string[],
  away: TeamIdentity,
  home: TeamIdentity
): TwoWayTeamOrder | null {
  if (labels.length < 2) return null;
  const [first, second] = labels;
  const firstAway = teamLabelMatches(first, away);
  const firstHome = teamLabelMatches(first, home);
  const secondAway = teamLabelMatches(second, away);
  const secondHome = teamLabelMatches(second, home);
  if (firstAway && !firstHome && secondHome && !secondAway) return "away_home";
  if (firstHome && !firstAway && secondAway && !secondHome) return "home_away";
  return null;
}
