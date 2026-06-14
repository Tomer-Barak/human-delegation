import { describe, expect, it } from "vitest";
import {
  createApiKey,
  decryptJson,
  encryptJson,
  hashToken,
  signPayload,
  verifyPayload,
} from "./security.js";

describe("security utilities", () => {
  it("encrypts channel credentials with authenticated encryption", () => {
    const key = Buffer.alloc(32, 4);
    const encrypted = encryptJson({ address: "human@example.com" }, key);
    expect(encrypted).not.toContain("human@example.com");
    expect(decryptJson(encrypted, key)).toEqual({ address: "human@example.com" });
    expect(() => decryptJson(encrypted, Buffer.alloc(32, 5))).toThrow();
  });

  it("signs, validates, and expires scoped payloads", () => {
    const token = signPayload(
      { purpose: "test", exp: Math.floor(Date.now() / 1000) + 60 },
      "secret",
    );
    expect(verifyPayload(token, "secret")).toMatchObject({ purpose: "test" });
    expect(() => verifyPayload(`${token}x`, "secret")).toThrow();
    const expired = signPayload(
      { purpose: "test", exp: Math.floor(Date.now() / 1000) - 1 },
      "secret",
    );
    expect(() => verifyPayload(expired, "secret")).toThrow("Token expired");
  });

  it("creates opaque API keys and stable hashes", () => {
    const key = createApiKey();
    expect(key.raw).toMatch(/^dth_/);
    expect(key.prefix).toBe(key.raw.slice(0, 12));
    expect(key.hash).toBe(hashToken(key.raw));
  });
});
