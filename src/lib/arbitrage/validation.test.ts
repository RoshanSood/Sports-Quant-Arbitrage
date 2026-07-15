import { describe, expect, it } from "vitest";
import { validateAgentPatch, validateRiskPatch, validateVenuePatch } from "./validation";

describe("arbitrage mutation validation", () => {
  it("accepts valid safety updates", () => {
    expect(validateRiskPatch({ killSwitch: true, maxOpenPositions: 2 })).toEqual({ killSwitch: true, maxOpenPositions: 2 });
  });

  it("rejects unknown, negative, and malformed fields", () => {
    expect(() => validateRiskPatch({ maxExposure: -1 })).toThrow();
    expect(() => validateRiskPatch({ surprise: true })).toThrow();
    expect(() => validateAgentPatch({ maxStake: 0 })).toThrow();
    expect(() => validateAgentPatch({ sizingMethod: "guess" as never })).toThrow();
    expect(() => validateAgentPatch({ venues: [] })).toThrow();
    expect(() => validateVenuePatch({ name: "spoofed" })).toThrow();
    expect(() => validateVenuePatch({ role: "owner" as never })).toThrow();
  });
});
