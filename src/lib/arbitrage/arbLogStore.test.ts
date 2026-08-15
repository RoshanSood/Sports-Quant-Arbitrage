import { describe, expect, it } from "vitest";
import { parseJsonLines } from "./arbLogStore";

describe("append-only arbitrage log parsing", () => {
  it("reads complete lines and ignores an interrupted trailing write", () => {
    const first = { id: "a", time: "2026-08-12T00:00:00.000Z" };
    const second = { id: "b", time: "2026-08-12T00:00:01.000Z" };
    expect(parseJsonLines(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n{"id":`)).toEqual([first, second]);
  });
});
