import { describe, expect, it } from "vitest";
import { teamMatchesTitle, teamsMatch } from "./teamNormalization";

describe("teamNormalization — tennis players", () => {
  it("matches abbreviated ESPN tennis names to full venue player names", () => {
    expect(teamsMatch("D. Shapovalov", "Denis Shapovalov", "tennis")).toBe(true);
    expect(teamsMatch("A. Gea", "Arthur Gea", "tennis")).toBe(true);
  });

  it("does not use team aliases or weak abbreviation matching for tennis", () => {
    expect(teamsMatch("A. Gea", "Alex Michelsen", "tennis")).toBe(false);
    expect(teamsMatch("New York", "Yankees", "tennis")).toBe(false);
  });

  it("finds abbreviated tennis players inside full event titles", () => {
    expect(
      teamMatchesTitle("D. Shapovalov", "D. Shapovalov", "DSH", "Arthur Gea vs Denis Shapovalov", "tennis")
    ).toBe(true);
    expect(teamMatchesTitle("A. Gea", "A. Gea", "AGE", "Arthur Gea vs Denis Shapovalov", "tennis")).toBe(true);
  });
});
