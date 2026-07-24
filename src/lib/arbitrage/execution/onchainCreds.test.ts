import { describe, expect, it } from "vitest";
import { extractOnchainCredsFromHeaders } from "./onchainCreds";

describe("extractOnchainCredsFromHeaders", () => {
  it("extracts browser-entered Polymarket intl credentials", () => {
    const headers = new Headers({
      "x-polymarket-key": Buffer.from("0xabc123").toString("base64"),
      "x-polymarket-funder": "0x1111111111111111111111111111111111111111",
      "x-polymarket-sig-type": "3",
    });

    expect(extractOnchainCredsFromHeaders(headers).polymarket).toEqual({
      key: "0xabc123",
      funder: "0x1111111111111111111111111111111111111111",
      sigType: 3,
    });
  });

  it("extracts browser-entered Polymarket US credentials", () => {
    const headers = new Headers({
      "x-polymarket-key-id": "pmus-key-id",
      "x-polymarket-secret": Buffer.from("base64-or-pem-secret").toString("base64"),
    });

    expect(extractOnchainCredsFromHeaders(headers).polymarket).toEqual({
      keyId: "pmus-key-id",
      secret: "base64-or-pem-secret",
    });
  });
});
