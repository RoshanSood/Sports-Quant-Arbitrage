export function pacificTodayDateStr(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

export function dateParamToIsoDate(date: string): string {
  return date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
}

// The Pacific (America/Los_Angeles) calendar date "YYYY-MM-DD" for a UTC/ISO timestamp.
// The slate is a Pacific day (pacificTodayDateStr), so a game/market must be dated by its
// Pacific day — NOT event.date.split("T")[0], whose UTC split rolls west-coast/evening
// games to the next calendar day and mislabels tonight's games as tomorrow. Every book
// compares against this so a market can't be matched to the wrong day's game.
export function pacificDateFromIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // Already a bare calendar date (no time) — return as-is; timezone-converting a
  // date-only string would wrongly shift it a day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = get("year"), m = get("month"), d = get("day");
  return y && m && d ? `${y}-${m}-${d}` : null;
}
