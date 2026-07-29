import { describe, expect, it } from "vitest";
import { teamsMatch } from "./teamNormalization";

describe("teamNormalization - MLS aliases", () => {
  it("matches common ESPN, Cloudbet, and exchange MLS naming variants", () => {
    expect(teamsMatch("Red Bull New York", "New York Red Bulls")).toBe(true);
    expect(teamsMatch("CF Montréal", "CF Montreal")).toBe(true);
    expect(teamsMatch("D.C. United", "DC United")).toBe(true);
    expect(teamsMatch("Sporting Kansas City", "Sporting Kansas City")).toBe(true);
    expect(teamsMatch("LAFC", "Los Angeles FC")).toBe(true);
    expect(teamsMatch("St. Louis CITY SC", "Saint Louis City SC")).toBe(true);
    expect(teamsMatch("Seattle Sounders FC", "Seattle Sounders")).toBe(true);
    expect(teamsMatch("Vancouver Whitecaps", "Vancouver Whitecaps FC")).toBe(true);
  });
});

describe("teamNormalization - Brazil soccer aliases", () => {
  it("matches Botafogo and Vitoria naming variants across venues", () => {
    expect(teamsMatch("Botafogo FR", "Botafogo")).toBe(true);
    expect(teamsMatch("Botafogo RJ", "Botafogo")).toBe(true);
    expect(teamsMatch("EC Vitoria", "Vitoria")).toBe(true);
    expect(teamsMatch("Esporte Clube Vitoria", "Vitoria")).toBe(true);
  });
});
