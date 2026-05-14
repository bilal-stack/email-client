import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH_BYTES = 32;
const KEY_LENGTH_HEX = KEY_LENGTH_BYTES * 2;

let cachedKey: ReturnType<typeof createSecretKey> | null = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== KEY_LENGTH_HEX || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(
      `ENCRYPTION_KEY must be ${KEY_LENGTH_BYTES} bytes as hex (${KEY_LENGTH_HEX} chars).`,
    );
  }
  cachedKey = createSecretKey(Buffer.from(hex, "hex"));
  return cachedKey;
}

export interface SealedSecret {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  tag: Uint8Array<ArrayBuffer>;
}

export function encrypt(plain: string): SealedSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Coerce Buffer<ArrayBufferLike> → Uint8Array<ArrayBuffer> for Prisma Bytes columns.
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    tag: new Uint8Array(tag),
  };
}

export function decrypt(ciphertext: Uint8Array, iv: Uint8Array, tag: Uint8Array): string {
  const decipher = createDecipheriv(ALGO, loadKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function resetKeyCacheForTests(): void {
  cachedKey = null;
}
