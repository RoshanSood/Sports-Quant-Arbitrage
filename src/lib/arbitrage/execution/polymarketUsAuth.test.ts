import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { authHeaders, signMessage } from "./polymarketUsAuth";

// Validate the Ed25519 request-signing scheme end-to-end: sign, then verify with the
// matching public key. Covers both accepted secret encodings (PKCS8 DER + raw 32-byte seed).
describe("Polymarket US Ed25519 signing", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const pkcs8B64 = der.toString("base64");
  const seedB64 = der.subarray(der.length - 32).toString("base64"); // last 32 bytes = the seed

  const msg = "1700000000000GET/v1/account/balances";

  it("signs with a PKCS8 secret and verifies", () => {
    const sig = signMessage(pkcs8B64, msg);
    expect(crypto.verify(null, Buffer.from(msg), publicKey, Buffer.from(sig, "base64"))).toBe(true);
  });

  it("signs with a raw 32-byte seed and verifies", () => {
    const sig = signMessage(seedB64, msg);
    expect(crypto.verify(null, Buffer.from(msg), publicKey, Buffer.from(sig, "base64"))).toBe(true);
  });

  it("authHeaders carries the three X-PM headers and signs timestamp+method+path", () => {
    const h = authHeaders({ keyId: "key-1", secret: seedB64 }, "get", "/v1/account/balances");
    expect(h["X-PM-Access-Key"]).toBe("key-1");
    expect(h["X-PM-Timestamp"]).toMatch(/^\d+$/);
    const expected = `${h["X-PM-Timestamp"]}GET/v1/account/balances`;
    expect(crypto.verify(null, Buffer.from(expected), publicKey, Buffer.from(h["X-PM-Signature"], "base64"))).toBe(true);
  });
});
