import fs from "fs/promises";
import path from "path";
import type { Venue } from "@/types/arbitrage";
import { DEFAULT_VENUES } from "./seed";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage");
const FILE = path.join(DATA_DIR, "venues.json");

async function read(): Promise<Venue[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf-8")) as Venue[];
  } catch {
    // Seed on first miss (write-through) so the file exists for subsequent updates.
    await write(DEFAULT_VENUES);
    return DEFAULT_VENUES;
  }
}

async function write(venues: Venue[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(venues, null, 2), "utf-8");
}

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
