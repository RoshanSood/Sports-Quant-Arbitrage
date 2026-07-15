import fs from "fs/promises";
import path from "path";
import type { RiskSettings } from "@/types/arbitrage";
import { DEFAULT_RISK } from "./seed";

const DATA_DIR = path.join(process.cwd(), "data", "arbitrage");
const FILE = path.join(DATA_DIR, "risk.json");

export async function getRiskSettings(): Promise<RiskSettings> {
  try {
    const stored = JSON.parse(await fs.readFile(FILE, "utf-8")) as Partial<RiskSettings>;
    // Merge over defaults so fields added later (e.g. maxLiveStakeUsd) are always present
    // — a missing live cap must never read as undefined and bypass the stake check.
    return { ...DEFAULT_RISK, ...stored };
  } catch {
    await write(DEFAULT_RISK);
    return DEFAULT_RISK;
  }
}

async function write(risk: RiskSettings): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(risk, null, 2), "utf-8");
}

export async function updateRiskSettings(partial: Partial<RiskSettings>): Promise<RiskSettings> {
  const current = await getRiskSettings();
  const next = { ...current, ...partial };
  await write(next);
  return next;
}
