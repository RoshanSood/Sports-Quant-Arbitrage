import fs from "fs/promises";
import path from "path";
import type { Venue } from "@/types/arbitrage";
import { DEFAULT_VENUES } from "./seed";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage");
const FILE = path.join(DATA_DIR, "venues.json");
let cached: { revision: number; venues: Venue[] } | null = null;
let revision = 0;

function cloneVenues(venues: Venue[]): Venue[] {
  return venues.map((venue) => ({ ...venue }));
}

async function read(): Promise<Venue[]> {
  if (cached) return cloneVenues(cached.venues);
  let stored: Venue[];
  try {
    stored = JSON.parse(await fs.readFile(FILE, "utf-8")) as Venue[];
  } catch {
    // Seed on first miss (write-through) so the file exists for subsequent updates.
    await write(DEFAULT_VENUES);
    return DEFAULT_VENUES;
  }
  // Merge in any seed venues added since this file was written (e.g. a newly-added
  // venue like predict.fun), keeping the user's stored edits to existing venues.
  const have = new Set(stored.map((v) => v.id));
  const missing = DEFAULT_VENUES.filter((v) => !have.has(v.id));
  if (missing.length) {
    stored = [...stored, ...missing];
    await write(stored);
  }
  cached = { revision, venues: cloneVenues(stored) };
  return cloneVenues(stored);
}

async function write(venues: Venue[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(venues, null, 2), "utf-8");
  revision += 1;
  cached = { revision, venues: cloneVenues(venues) };
}

export function venueConfigRevision(): number { return cached?.revision ?? revision; }

export async function getVenues(): Promise<Venue[]> {
  return read();
}

export async function getVenue(id: string): Promise<Venue | null> {
  return (await read()).find((v) => v.id === id) ?? null;
}

export async function updateVenue(id: string, partial: Partial<Venue>): Promise<Venue | null> {
  const venues = await read();
  const idx = venues.findIndex((v) => v.id === id);
  if (idx === -1) return null;
  venues[idx] = { ...venues[idx], ...partial, id: venues[idx].id };
  await write(venues);
  return venues[idx];
}
