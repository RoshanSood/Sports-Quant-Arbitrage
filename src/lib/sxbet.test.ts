import { describe, it, expect } from "vitest";
import { parseSpreadLine } from "./sxbet";

// Regression: an SX.bet "Chicago Cubs -4.5" run-line was mislabeled +1.5 (the old code did
// `name.includes("-1.5") ? -1.5 : 1.5`) and matched against a real 1.5 spread, producing a
// non-complementary, unhedged live bet. The line must be parsed from the outcome name, and
// only the ±1.5 run-line (Math.abs === 1.5) is ingested — everything else is skipped.
describe("sxbet parseSpreadLine", () => {
  it("parses the reported -4.5 line that was mislabeled +1.5", () => {
    expect(parseSpreadLine("Chicago Cubs -4.5")).toBe(-4.5);
    // Guard used by ingestion: -4.5 is NOT the run-line, so it is excluded.
    expect(Math.abs(parseSpreadLine("Chicago Cubs -4.5")!)).not.toBe(1.5);
  });

  it("parses the standard ±1.5 run-line with the correct sign", () => {
    expect(parseSpreadLine("Chicago Cubs +1.5")).toBe(1.5);
    expect(parseSpreadLine("Chicago Cubs -1.5")).toBe(-1.5);
    expect(parseSpreadLine("Los Angeles Dodgers -1.5")).toBe(-1.5);
    expect(Math.abs(parseSpreadLine("Chicago Cubs -1.5")!)).toBe(1.5);
  });

  it("parses other alternate lines (which ingestion then skips)", () => {
    expect(parseSpreadLine("Team -2.5")).toBe(-2.5);
    expect(parseSpreadLine("Team +3.5")).toBe(3.5);
  });

  it("requires an explicit sign so team names can't be misread as a line", () => {
    expect(parseSpreadLine("Chicago Cubs")).toBeNull();
    expect(parseSpreadLine("Oakland Athletics")).toBeNull();
    expect(parseSpreadLine("")).toBeNull();
  });
});
