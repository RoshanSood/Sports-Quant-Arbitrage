import type { Agent, RiskSettings, Venue } from "@/types/arbitrage";

const RISK_KEYS = new Set<keyof RiskSettings>([
  "killSwitch",
  "maxExposure",
  "currentExposure",
  "maxDailyLoss",
  "dailyPnl",
  "maxOpenPositions",
  "pauseOnNaked",
  "staleQuoteMs",
  "minLiquidityUsd",
  "perVenueCap",
]);
const AGENT_KEYS = new Set<keyof Agent>([
  "name", "strategy", "enabled", "paper", "live", "autoTrade", "minEdge", "maxEdge",
  "sizingMethod", "maxStake", "venues", "staleQuoteMs",
]);
const VENUE_KEYS = new Set<keyof Venue>(["enabled", "viewOnly", "role"]);

export function validateRiskPatch(input: unknown): Partial<RiskSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Risk update must be an object");
  const patch = input as Record<string, unknown>;
  for (const key of Object.keys(patch)) if (!RISK_KEYS.has(key as keyof RiskSettings)) throw new Error(`Unknown risk field: ${key}`);
  for (const key of ["killSwitch", "pauseOnNaked"] as const) {
    if (patch[key] != null && typeof patch[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  for (const key of ["maxExposure", "currentExposure", "maxDailyLoss", "staleQuoteMs", "minLiquidityUsd"] as const) {
    if (patch[key] != null && (!(typeof patch[key] === "number") || !Number.isFinite(patch[key]) || patch[key] < 0)) throw new Error(`${key} must be a non-negative number`);
  }
  if (patch.dailyPnl != null && (typeof patch.dailyPnl !== "number" || !Number.isFinite(patch.dailyPnl))) throw new Error("dailyPnl must be finite");
  if (patch.maxOpenPositions != null && (!Number.isInteger(patch.maxOpenPositions) || (patch.maxOpenPositions as number) < 1)) throw new Error("maxOpenPositions must be a positive integer");
  if (patch.perVenueCap != null) {
    if (typeof patch.perVenueCap !== "object" || Array.isArray(patch.perVenueCap)) throw new Error("perVenueCap must be an object");
    for (const [venue, cap] of Object.entries(patch.perVenueCap as Record<string, unknown>)) {
      if (!venue || typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) throw new Error("Venue caps must be non-negative numbers");
    }
  }
  return patch as Partial<RiskSettings>;
}

export function validateAgentPatch(input: unknown): Partial<Agent> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Agent update must be an object");
  const patch = input as Partial<Agent>;
  for (const key of Object.keys(patch)) if (!AGENT_KEYS.has(key as keyof Agent)) throw new Error(`Unknown agent field: ${key}`);
  for (const key of ["enabled", "paper", "live", "autoTrade"] as const) {
    if (patch[key] != null && typeof patch[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  for (const key of ["minEdge", "maxEdge"] as const) {
    if (patch[key] != null && (typeof patch[key] !== "number" || !Number.isFinite(patch[key]) || patch[key]! < 0 || patch[key]! > 1)) throw new Error(`${key} must be between 0 and 1`);
  }
  if (patch.strategy != null && patch.strategy !== "arbitrage" && patch.strategy !== "value") throw new Error("strategy is invalid");
  if (patch.sizingMethod != null && !["equal_profit", "fixed", "proportional"].includes(patch.sizingMethod)) throw new Error("sizingMethod is invalid");
  if (patch.maxStake != null && (typeof patch.maxStake !== "number" || !Number.isFinite(patch.maxStake) || patch.maxStake <= 0)) throw new Error("maxStake must be positive");
  if (patch.staleQuoteMs != null && (typeof patch.staleQuoteMs !== "number" || !Number.isFinite(patch.staleQuoteMs) || patch.staleQuoteMs < 0)) throw new Error("staleQuoteMs must be non-negative");
  if (patch.venues != null && (!Array.isArray(patch.venues) || patch.venues.length === 0 || patch.venues.some((venue) => typeof venue !== "string" || venue.trim() === ""))) throw new Error("venues must be a non-empty string array");
  return patch;
}

export function validateVenuePatch(input: unknown): Partial<Venue> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Venue update must be an object");
  const patch = input as Partial<Venue>;
  for (const key of Object.keys(patch)) if (!VENUE_KEYS.has(key as keyof Venue)) throw new Error(`Unknown venue field: ${key}`);
  for (const key of ["enabled", "viewOnly"] as const) {
    if (patch[key] != null && typeof patch[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  if (patch.role != null && !["sharp", "primary", "hedge", "reference"].includes(patch.role)) throw new Error("role is invalid");
  return patch;
}
