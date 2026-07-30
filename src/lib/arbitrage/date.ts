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

export function dateParamToStorageDate(date: string): string {
  return date.replace(/-/g, "").slice(0, 8);
}

export function dateParamToIsoDate(date: string): string {
  const storageDate = dateParamToStorageDate(date);
  return storageDate.length === 8
    ? `${storageDate.slice(0, 4)}-${storageDate.slice(4, 6)}-${storageDate.slice(6, 8)}`
    : date;
}
