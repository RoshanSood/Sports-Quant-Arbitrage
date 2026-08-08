import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEspnJson } from "./espnFetch";

afterEach(() => vi.unstubAllGlobals());

describe("fetchEspnJson", () => {
  it("retries a transient TLS failure and requests fresh uncached JSON", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{ id: "1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEspnJson<{ events: { id: string }[] }>("https://site.api.espn.com/test", [0, 0]))
      .resolves.toEqual({ events: [{ id: "1" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("https://site.api.espn.com/test", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  });

  it("does not retry deterministic client errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEspnJson("https://site.api.espn.com/missing", [0, 0, 0]))
      .rejects.toThrow("ESPN API error: 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
