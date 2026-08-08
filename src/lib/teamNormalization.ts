// Maps common short/nickname forms to canonical full names
export const TEAM_ALIASES: Record<string, string> = {
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

export const MLS_TEAM_ALIASES: Record<string, string> = {
  "atlanta": "atlanta united fc",
  "atlanta united": "atlanta united fc",
  "atlanta united fc": "atlanta united fc",
  "austin": "austin fc",
  "austin fc": "austin fc",
  "charlotte": "charlotte fc",
  "charlotte fc": "charlotte fc",
  "chicago": "chicago fire fc",
  "chicago fire": "chicago fire fc",
  "chicago fire fc": "chicago fire fc",
  "cincinnati": "fc cincinnati",
  "fc cincinnati": "fc cincinnati",
  "colorado": "colorado rapids",
  "colorado rapids": "colorado rapids",
  "colorado rapids sc": "colorado rapids",
  "columbus": "columbus crew",
  "columbus crew": "columbus crew",
  "dc": "d.c. united",
  "dc united": "d.c. united",
  "d.c. united": "d.c. united",
  "dallas": "fc dallas",
  "fc dallas": "fc dallas",
  "houston": "houston dynamo fc",
  "houston dynamo": "houston dynamo fc",
  "houston dynamo fc": "houston dynamo fc",
  "inter miami": "inter miami cf",
  "inter miami cf": "inter miami cf",
  "la galaxy": "la galaxy",
  "galaxy": "la galaxy",
  "lafc": "los angeles fc",
  "la fc": "los angeles fc",
  "los angeles fc": "los angeles fc",
  "minnesota": "minnesota united fc",
  "minnesota united": "minnesota united fc",
  "minnesota united fc": "minnesota united fc",
  "montreal": "cf montreal",
  "cf montreal": "cf montreal",
  "cf montréal": "cf montreal",
  "new england": "new england revolution",
  "new england revolution": "new england revolution",
  "nashville": "nashville sc",
  "nashville sc": "nashville sc",
  "nycfc": "new york city fc",
  "new york city": "new york city fc",
  "new york city fc": "new york city fc",
  "ny red bulls": "new york red bulls",
  "new york red bulls": "new york red bulls",
  "orlando": "orlando city sc",
  "orlando city": "orlando city sc",
  "orlando city sc": "orlando city sc",
  "philadelphia": "philadelphia union",
  "philadelphia union": "philadelphia union",
  "portland": "portland timbers",
  "portland timbers": "portland timbers",
  "real salt lake": "real salt lake",
  "salt lake": "real salt lake",
  "rsl": "real salt lake",
  "san diego": "san diego fc",
  "san diego fc": "san diego fc",
  "san jose": "san jose earthquakes",
  "san jose earthquakes": "san jose earthquakes",
  "seattle": "seattle sounders fc",
  "seattle sounders": "seattle sounders fc",
  "seattle sounders fc": "seattle sounders fc",
  "sporting kansas city": "sporting kansas city",
  "kansas city": "sporting kansas city",
  "skc": "sporting kansas city",
  "st louis": "st. louis city sc",
  "st. louis": "st. louis city sc",
  "st louis city": "st. louis city sc",
  "st. louis city": "st. louis city sc",
  "st. louis city sc": "st. louis city sc",
  "toronto": "toronto fc",
  "toronto fc": "toronto fc",
  "vancouver": "vancouver whitecaps",
  "vancouver whitecaps": "vancouver whitecaps",
  "vancouver whitecaps fc": "vancouver whitecaps",
};

function aliasesFor(sport?: string): Record<string, string> {
  if (sport === "tennis") return {};
  return sport === "soccer" ? MLS_TEAM_ALIASES : TEAM_ALIASES;
}

function normalizeRaw(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tennisNameParts(name: string): { first: string | null; last: string | null; raw: string } {
  const raw = normalizeRaw(name);
  const parts = raw.split(" ").filter(Boolean);
  return {
    first: parts.length >= 2 ? parts[0] : null,
    last: parts.at(-1) ?? null,
    raw,
  };
}

function tennisNamesMatch(name1: string, name2: string): boolean {
  const a = tennisNameParts(name1);
  const b = tennisNameParts(name2);
  if (!a.raw || !b.raw) return false;
  if (a.raw === b.raw) return true;
  if (!a.last || !b.last || a.last !== b.last) return false;

  // ESPN often abbreviates tennis players as "D. Shapovalov" while venues use
  // "Denis Shapovalov". Matching last name + first initial bridges that safely.
  if (a.first && b.first) return a.first[0] === b.first[0];
  return true;
}

function tennisTitleMatches(espnName: string, espnShortName: string, title: string): boolean {
  const titleNorm = normalizeRaw(title);
  for (const name of [espnName, espnShortName]) {
    const player = tennisNameParts(name);
    if (!player.last || !titleNorm.includes(player.last)) continue;
    if (!player.first || player.first.length > 1) return true;
    const fullNamePattern = new RegExp(`\\b${player.first[0]}\\w*\\s+${player.last}\\b`);
    if (fullNamePattern.test(titleNorm)) return true;
  }
  return false;
}

// Returns the canonical full name for a SINGLE team name/abbreviation.
// NEVER pass a full event title (e.g. "Angels vs. Blue Jays") — that will match the wrong team.
export function normalizeTeamName(name: string, sport?: string): string {
  const lower = normalizeRaw(name);
  const aliases = aliasesFor(sport);
  if (aliases[lower]) return aliases[lower];
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (lower.includes(alias)) return canonical;
  }
  return lower;
}

// Check whether a single team (identified by ESPN name, short name, abbreviation)
// appears anywhere in a Polymarket event title.
// This does substring checks, NOT normalizeTeamName on the full title.
export function teamMatchesTitle(
  espnName: string,
  espnShortName: string,
  espnAbbr: string,
  title: string,
  sport?: string
): boolean {
  if (sport === "tennis" && tennisTitleMatches(espnName, espnShortName, title)) return true;

  const lower = normalizeRaw(title);

  // Direct substring: full ESPN name (e.g. "Los Angeles Angels")
  if (lower.includes(normalizeRaw(espnName))) return true;
  // Short name (e.g. "Angels")
  if (lower.includes(normalizeRaw(espnShortName))) return true;

  // All known aliases for this team's canonical name
  const canonical = normalizeTeamName(espnName, sport);
  for (const [alias, can] of Object.entries(aliasesFor(sport))) {
    if (can === canonical && lower.includes(alias)) return true;
  }

  // Abbreviation check (3+ chars, e.g. "NYM", "LAD" in "NYM vs LAD" sub-titles)
  if (espnAbbr.length >= 3 && lower.includes(normalizeRaw(espnAbbr))) return true;

  return false;
}

// Legacy helper kept for backward compatibility in other modules (spread/moneyline labeling)
export function teamsMatch(name1: string, name2: string, sport?: string): boolean {
  if (sport === "tennis") return tennisNamesMatch(name1, name2);

  const n1 = normalizeTeamName(name1, sport);
  const n2 = normalizeTeamName(name2, sport);
  if (n1 === n2) return true;
  if (n1.includes(n2) || n2.includes(n1)) return true;
  return false;
}
