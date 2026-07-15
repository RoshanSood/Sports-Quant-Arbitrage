import fs from "fs/promises";
import path from "path";
import type { RiskSettings } from "@/types/arbitrage";
import { DEFAULT_RISK } from "./seed";
import { mutateJson, readJson, writeJsonAtomic } from "./jsonStore";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage");
const FILE = path.join(DATA_DIR, "risk.json");

export async function getRiskSettings(): Promise<RiskSettings> {
  const risk = await readJson(FILE, DEFAULT_RISK);
  if (risk === DEFAULT_RISK) await write(DEFAULT_RISK);
  return risk;
}

async function write(risk: RiskSettings): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(FILE, risk);
}

export async function updateRiskSettings(partial: Partial<RiskSettings>): Promise<RiskSettings> {
  return mutateJson(FILE, DEFAULT_RISK, (current) => {
    const next = { ...current, ...partial };
    return { value: next, result: next };
  });
}
