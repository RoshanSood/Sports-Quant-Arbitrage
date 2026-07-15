import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { mutateJson, readJson } from "./jsonStore";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe("locked JSON persistence", () => {
  it("does not lose concurrent read-modify-write updates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arb-store-"));
    dirs.push(dir);
    const file = path.join(dir, "counter.json");
    await Promise.all(Array.from({ length: 25 }, () => mutateJson(file, { count: 0 }, (current) => ({
      value: { count: current.count + 1 },
      result: undefined,
    }))));
    expect(await readJson(file, { count: 0 })).toEqual({ count: 25 });
  });
});
