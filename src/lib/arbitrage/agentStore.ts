import fs from "fs/promises";
import path from "path";
import type { Agent } from "@/types/arbitrage";
import { DEFAULT_AGENT } from "./seed";
import { mutateJson, readJson, writeJsonAtomic } from "./jsonStore";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage");
const FILE = path.join(DATA_DIR, "agents.json");

async function read(): Promise<Agent[]> {
  const agents = await readJson(FILE, [DEFAULT_AGENT]);
  if (agents.length === 1 && agents[0] === DEFAULT_AGENT) await write(agents);
  return agents;
}

async function write(agents: Agent[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(FILE, agents);
}

export async function getAgents(): Promise<Agent[]> {
  return read();
}

export async function getAgent(id: string): Promise<Agent | null> {
  return (await read()).find((a) => a.id === id) ?? null;
}

export async function updateAgent(id: string, partial: Partial<Agent>): Promise<Agent | null> {
  return mutateJson(FILE, [DEFAULT_AGENT], (agents) => {
    const idx = agents.findIndex((agent) => agent.id === id);
    if (idx === -1) return { value: agents, result: null };
    const next = [...agents];
    next[idx] = { ...next[idx], ...partial, id: next[idx].id };
    return { value: next, result: next[idx] };
  });
}
