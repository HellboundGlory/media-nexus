// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

describe("crypto", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const payload = encryptSecret("mn_super-secret-key", "test-secret");
    expect(decryptSecret(payload, "test-secret")).toBe("mn_super-secret-key");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-plaintext", "test-secret");
    const b = encryptSecret("same-plaintext", "test-secret");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong secret", () => {
    const payload = encryptSecret("mn_super-secret-key", "test-secret");
    expect(() => decryptSecret(payload, "wrong-secret")).toThrow();
  });

  it("rejects a malformed payload", () => {
    expect(() => decryptSecret("not-a-valid-payload", "test-secret")).toThrow();
  });
});
