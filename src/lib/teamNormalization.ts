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

// Summer League feeds mix full NBA names, nicknames, cities, and Kalshi's
// single-letter city disambiguators. Keep them scoped away from MLB aliases.
export const NBA_TEAM_ALIASES: Record<string, string> = {
  atl: "atlanta hawks", atlanta: "atlanta hawks", hawks: "atlanta hawks", "atlanta hawks": "atlanta hawks",
  bos: "boston celtics", boston: "boston celtics", celtics: "boston celtics", "boston celtics": "boston celtics",
  bkn: "brooklyn nets", brooklyn: "brooklyn nets", nets: "brooklyn nets", "brooklyn nets": "brooklyn nets",
  cha: "charlotte hornets", charlotte: "charlotte hornets", hornets: "charlotte hornets", "charlotte hornets": "charlotte hornets",
  chi: "chicago bulls", chicago: "chicago bulls", bulls: "chicago bulls", "chicago bulls": "chicago bulls",
  cle: "cleveland cavaliers", cleveland: "cleveland cavaliers", cavaliers: "cleveland cavaliers", cavs: "cleveland cavaliers", "cleveland cavaliers": "cleveland cavaliers",
  dal: "dallas mavericks", dallas: "dallas mavericks", mavericks: "dallas mavericks", mavs: "dallas mavericks", "dallas mavericks": "dallas mavericks",
  den: "denver nuggets", denver: "denver nuggets", nuggets: "denver nuggets", "denver nuggets": "denver nuggets",
  det: "detroit pistons", detroit: "detroit pistons", pistons: "detroit pistons", "detroit pistons": "detroit pistons",
  gsw: "golden state warriors", "golden state": "golden state warriors", warriors: "golden state warriors", "golden state warriors": "golden state warriors",
  hou: "houston rockets", houston: "houston rockets", rockets: "houston rockets", "houston rockets": "houston rockets",
  ind: "indiana pacers", indiana: "indiana pacers", pacers: "indiana pacers", "indiana pacers": "indiana pacers",
  lac: "los angeles clippers", "la clippers": "los angeles clippers", "l a clippers": "los angeles clippers", clippers: "los angeles clippers", "los angeles c": "los angeles clippers", "los angeles clippers": "los angeles clippers",
  lal: "los angeles lakers", "la lakers": "los angeles lakers", "l a lakers": "los angeles lakers", lakers: "los angeles lakers", "los angeles l": "los angeles lakers", "los angeles lakers": "los angeles lakers",
  mem: "memphis grizzlies", memphis: "memphis grizzlies", grizzlies: "memphis grizzlies", "memphis grizzlies": "memphis grizzlies",
  mia: "miami heat", miami: "miami heat", heat: "miami heat", "miami heat": "miami heat",
  mil: "milwaukee bucks", milwaukee: "milwaukee bucks", bucks: "milwaukee bucks", "milwaukee bucks": "milwaukee bucks",
  min: "minnesota timberwolves", minnesota: "minnesota timberwolves", timberwolves: "minnesota timberwolves", wolves: "minnesota timberwolves", "minnesota timberwolves": "minnesota timberwolves",
  nop: "new orleans pelicans", "new orleans": "new orleans pelicans", pelicans: "new orleans pelicans", "new orleans pelicans": "new orleans pelicans",
  nyk: "new york knicks", "new york": "new york knicks", knicks: "new york knicks", "new york knicks": "new york knicks",
  okc: "oklahoma city thunder", "oklahoma city": "oklahoma city thunder", thunder: "oklahoma city thunder", "oklahoma city thunder": "oklahoma city thunder",
  orl: "orlando magic", orlando: "orlando magic", magic: "orlando magic", "orlando magic": "orlando magic",
  phi: "philadelphia 76ers", philadelphia: "philadelphia 76ers", "76ers": "philadelphia 76ers", sixers: "philadelphia 76ers", "philadelphia 76ers": "philadelphia 76ers",
  phx: "phoenix suns", phoenix: "phoenix suns", suns: "phoenix suns", "phoenix suns": "phoenix suns",
  por: "portland trail blazers", portland: "portland trail blazers", blazers: "portland trail blazers", "trail blazers": "portland trail blazers", "portland trail blazers": "portland trail blazers",
  sac: "sacramento kings", sacramento: "sacramento kings", kings: "sacramento kings", "sacramento kings": "sacramento kings",
  sas: "san antonio spurs", "san antonio": "san antonio spurs", spurs: "san antonio spurs", "san antonio spurs": "san antonio spurs",
  tor: "toronto raptors", toronto: "toronto raptors", raptors: "toronto raptors", "toronto raptors": "toronto raptors",
  uta: "utah jazz", utah: "utah jazz", jazz: "utah jazz", "utah jazz": "utah jazz",
  wsh: "washington wizards", washington: "washington wizards", wizards: "washington wizards", "washington wizards": "washington wizards",
};

function aliasesForLeague(league?: string): Record<string, string> {
  return league?.toLowerCase() === "nba_summer" ? NBA_TEAM_ALIASES : TEAM_ALIASES;
}

function matchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsPhrase(value: string, phrase: string): boolean {
  const haystack = ` ${matchText(value)} `;
  const needle = matchText(phrase);
  return Boolean(needle) && haystack.includes(` ${needle} `);
}

// Returns the canonical full name for a SINGLE team name/abbreviation.
// NEVER pass a full event title (e.g. "Angels vs. Blue Jays") — that will match the wrong team.
export function normalizeTeamName(name: string, league?: string): string {
  const lower = matchText(name);
  const aliases = aliasesForLeague(league);
  const direct = Object.entries(aliases).find(([alias]) => matchText(alias) === lower);
  if (direct) return direct[1];
  for (const [alias, canonical] of Object.entries(aliases).sort((a, b) => b[0].length - a[0].length)) {
    if (containsPhrase(lower, alias)) return canonical;
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
  league?: string
): boolean {
  const lower = matchText(title);

  // Direct substring: full ESPN name (e.g. "Los Angeles Angels")
  if (containsPhrase(lower, espnName)) return true;
  // Short name (e.g. "Angels")
  if (containsPhrase(lower, espnShortName)) return true;

  // All known aliases for this team's canonical name
  const aliases = aliasesForLeague(league);
  const canonical = normalizeTeamName(espnName, league);
  for (const [alias, can] of Object.entries(aliases)) {
    if (can === canonical && containsPhrase(lower, alias)) return true;
  }

  // Abbreviation check (3+ chars, e.g. "NYM", "LAD" in "NYM vs LAD" sub-titles)
  if (espnAbbr.length >= 3 && containsPhrase(lower, espnAbbr)) return true;

  return false;
}

// Legacy helper kept for backward compatibility in other modules (spread/moneyline labeling)
export function teamsMatch(name1: string, name2: string, league?: string): boolean {
  const n1 = normalizeTeamName(name1, league);
  const n2 = normalizeTeamName(name2, league);
  if (n1 === n2) return true;
  if (n1.includes(n2) || n2.includes(n1)) return true;
  return false;
}
