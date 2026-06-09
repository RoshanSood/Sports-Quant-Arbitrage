// WNBA team name aliases → canonical full name
export const WNBA_TEAM_ALIASES: Record<string, string> = {
  // Atlanta Dream
  "dream": "atlanta dream",
  "atlanta": "atlanta dream",
  "atlanta dream": "atlanta dream",
  // Chicago Sky
  "sky": "chicago sky",
  "chicago": "chicago sky",
  "chicago sky": "chicago sky",
  // Connecticut Sun
  "sun": "connecticut sun",
  "connecticut": "connecticut sun",
  "connecticut sun": "connecticut sun",
  "conn": "connecticut sun",
  // Dallas Wings
  "wings": "dallas wings",
  "dallas": "dallas wings",
  "dallas wings": "dallas wings",
  // Golden State Valkyries (2025 expansion)
  "valkyries": "golden state valkyries",
  "golden state": "golden state valkyries",
  "golden state valkyries": "golden state valkyries",
  "gsv": "golden state valkyries",
  // Indiana Fever
  "fever": "indiana fever",
  "indiana": "indiana fever",
  "indiana fever": "indiana fever",
  "ind": "indiana fever",
  // Las Vegas Aces
  "aces": "las vegas aces",
  "las vegas": "las vegas aces",
  "las vegas aces": "las vegas aces",
  "lv": "las vegas aces",
  // Los Angeles Sparks
  "sparks": "los angeles sparks",
  "los angeles sparks": "los angeles sparks",
  "la sparks": "los angeles sparks",
  // Minnesota Lynx
  "lynx": "minnesota lynx",
  "minnesota": "minnesota lynx",
  "minnesota lynx": "minnesota lynx",
  "min": "minnesota lynx",
  // New York Liberty
  "liberty": "new york liberty",
  "new york liberty": "new york liberty",
  "nyl": "new york liberty",
  "ny liberty": "new york liberty",
  // Phoenix Mercury
  "mercury": "phoenix mercury",
  "phoenix": "phoenix mercury",
  "phoenix mercury": "phoenix mercury",
  "phx": "phoenix mercury",
  // Portland Fire (2026 expansion)
  "fire": "portland fire",
  "portland": "portland fire",
  "portland fire": "portland fire",
  "por": "portland fire",
  // Seattle Storm
  "storm": "seattle storm",
  "seattle": "seattle storm",
  "seattle storm": "seattle storm",
  "sea": "seattle storm",
  // Toronto Tempo (2026 expansion)
  "tempo": "toronto tempo",
  "toronto": "toronto tempo",
  "toronto tempo": "toronto tempo",
  // Washington Mystics
  "mystics": "washington mystics",
  "washington": "washington mystics",
  "washington mystics": "washington mystics",
  "wsh": "washington mystics",
};

export function normalizeWNBATeam(name: string): string {
  const lower = name.toLowerCase().trim();
  if (WNBA_TEAM_ALIASES[lower]) return WNBA_TEAM_ALIASES[lower];
  for (const [alias, canonical] of Object.entries(WNBA_TEAM_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  return lower;
}

// Safe title matching — checks substrings without normalizing the whole title
export function wnbaTeamMatchesTitle(
  espnName: string,
  espnShortName: string,
  espnAbbr: string,
  title: string
): boolean {
  const lower = title.toLowerCase();
  if (lower.includes(espnName.toLowerCase())) return true;
  if (lower.includes(espnShortName.toLowerCase())) return true;
  const canonical = normalizeWNBATeam(espnName);
  for (const [alias, can] of Object.entries(WNBA_TEAM_ALIASES)) {
    if (can === canonical && lower.includes(alias)) return true;
  }
  // Abbreviation (word-boundary safe for short codes)
  const abbrLower = espnAbbr.toLowerCase();
  if (abbrLower.length >= 3) {
    if (lower.includes(abbrLower)) return true;
  }
  return false;
}

// Match two team names against each other (for outcome → team label mapping)
export function wnbaTeamsMatch(name1: string, name2: string): boolean {
  const n1 = normalizeWNBATeam(name1);
  const n2 = normalizeWNBATeam(name2);
  if (n1 === n2) return true;
  if (n1.includes(n2) || n2.includes(n1)) return true;
  return false;
}
