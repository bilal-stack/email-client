import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto";

describe("crypto", () => {
  it("round-trips encrypt then decrypt to the original plaintext", () => {
    const plain = "hello, encrypted world";
    const sealed = encrypt(plain);
    expect(decrypt(sealed.ciphertext, sealed.iv, sealed.tag)).toBe(plain);
  });

  it("produces different IV and ciphertext on each call for the same plaintext", () => {
    const a = encrypt("same input");
    const b = encrypt("same input");
    expect(Buffer.compare(a.iv, b.iv)).not.toBe(0);
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0);
  });

  it("throws when the ciphertext is tampered", () => {
    const sealed = encrypt("important");
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => decrypt(tampered, sealed.iv, sealed.tag)).toThrow();
  });

  it("throws when the auth tag is tampered", () => {
    const sealed = encrypt("important");
    const tampered = Buffer.from(sealed.tag);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => decrypt(sealed.ciphertext, sealed.iv, tampered)).toThrow();
  });
});
