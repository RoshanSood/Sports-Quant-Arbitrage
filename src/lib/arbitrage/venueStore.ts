import fs from "fs/promises";
import path from "path";
import type { Venue } from "@/types/arbitrage";
import { DEFAULT_VENUES } from "./seed";
import { mutateJson, readJson, writeJsonAtomic } from "./jsonStore";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage");
const FILE = path.join(DATA_DIR, "venues.json");

async function read(): Promise<Venue[]> {
  const venues = await readJson(FILE, DEFAULT_VENUES);
  if (venues === DEFAULT_VENUES) await write(venues);
  return venues;
}

async function write(venues: Venue[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(FILE, venues);
}

export async function getVenues(): Promise<Venue[]> {
  return read();
}

export async function getVenue(id: string): Promise<Venue | null> {
  return (await read()).find((v) => v.id === id) ?? null;
}

export async function updateVenue(id: string, partial: Partial<Venue>): Promise<Venue | null> {
  return mutateJson(FILE, DEFAULT_VENUES, (venues) => {
    const idx = venues.findIndex((venue) => venue.id === id);
    if (idx === -1) return { value: venues, result: null };
    const next = [...venues];
    next[idx] = { ...next[idx], ...partial, id: next[idx].id };
    return { value: next, result: next[idx] };
  });
}
