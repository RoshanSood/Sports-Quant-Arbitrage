import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorized } from "./adminAuth";

afterEach(() => vi.unstubAllEnvs());

describe("admin authorization", () => {
  it("accepts the configured password from a header or request body", () => {
    vi.stubEnv("ADMIN_PASSWORD", "secret-value");
    expect(isAuthorized(new Request("http://localhost", { headers: { "x-admin-password": "secret-value" } }))).toBe(true);
    expect(isAuthorized(new Request("http://localhost"), "secret-value")).toBe(true);
  });

  it("rejects missing and incorrect credentials", () => {
    vi.stubEnv("ADMIN_PASSWORD", "secret-value");
    expect(isAuthorized(new Request("http://localhost"))).toBe(false);
    expect(isAuthorized(new Request("http://localhost"), "wrong")).toBe(false);
  });
});
