import fs from "fs/promises";
import path from "path";
import type { Agent } from "@/types/arbitrage";
import { DEFAULT_AGENT } from "./seed";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage");
const FILE = path.join(DATA_DIR, "agents.json");

async function read(): Promise<Agent[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf-8")) as Agent[];
  } catch {
    await write([DEFAULT_AGENT]);
    return [DEFAULT_AGENT];
  }
}

async function write(agents: Agent[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(agents, null, 2), "utf-8");
}

export async function getAgents(): Promise<Agent[]> {
  return read();
}

export async function getAgent(id: string): Promise<Agent | null> {
  return (await read()).find((a) => a.id === id) ?? null;
}

export async function updateAgent(id: string, partial: Partial<Agent>): Promise<Agent | null> {
  const agents = await read();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  agents[idx] = { ...agents[idx], ...partial, id: agents[idx].id };
  await write(agents);
  return agents[idx];
}
