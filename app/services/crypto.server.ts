/**
 * Encryption engine: AES-256-GCM using Node's built-in `crypto`.
 *
 * - MASTER_ENCRYPTION_KEY is never used directly. HKDF-SHA256 derives one subkey
 *   per purpose, so the session cookie key, the credential key and the
 *   fingerprint key are cryptographically independent.
 * - Every encryption uses a new random 96-bit IV. Every ciphertext carries a
 *   full 128-bit auth tag, which is enforced on decrypt to block tag truncation.
 * - Callers pass AAD (additional authenticated data) that binds a ciphertext to
 *   its row, e.g. "provider-credential:FLY:apiToken:v3". A ciphertext copied
 *   into another row will not decrypt.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "./env.server";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HKDF_SALT = "veltrix.hkdf.v1";

/** Raise this, and re-encrypt, when the master key or the derivation changes. */
export const CURRENT_KEY_VERSION = 1;

export type KeyPurpose = "credentials" | "resource-secrets" | "session" | "fingerprint";

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  keyVersion: number;
}

export class DecryptionError extends Error {
  constructor() {
    // Deliberately vague: never say whether the key, the IV or the AAD was wrong.
    super("Decryption failed: ciphertext is corrupt, tampered with, or was encrypted under a different key.");
    this.name = "DecryptionError";
  }
}

let masterKey: Buffer | null = null;
const subkeys = new Map<string, Buffer>();

function getMasterKey(): Buffer {
  if (!masterKey) masterKey = Buffer.from(env().MASTER_ENCRYPTION_KEY, "hex");
  return masterKey;
}

export function deriveKey(purpose: KeyPurpose, keyVersion: number = CURRENT_KEY_VERSION): Buffer {
  const id = `${purpose}:v${keyVersion}`;
  let key = subkeys.get(id);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", getMasterKey(), HKDF_SALT, `veltrix/${id}`, KEY_LENGTH));
    subkeys.set(id, key);
  }
  return key;
}

export function encrypt(plaintext: string, opts: { purpose: KeyPurpose; aad: string }): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveKey(opts.purpose), iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(opts.aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function decrypt(payload: EncryptedPayload, opts: { purpose: KeyPurpose; aad: string }): string {
  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) throw new DecryptionError();

  try {
    const decipher = createDecipheriv(ALGORITHM, deriveKey(opts.purpose, payload.keyVersion), iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(opts.aad, "utf8"));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new DecryptionError();
  }
}

/**
 * Keyed, irreversible fingerprint (HMAC-SHA256, truncated to 64 bits).
 * Lets admins check which key is installed, and spot a re-submit of the same
 * value, without storing or showing any part of the secret. A plain hash or
 * "last 4 characters" would leak information.
 */
export function fingerprint(secret: string): string {
  return createHmac("sha256", deriveKey("fingerprint")).update(secret, "utf8").digest("hex").slice(0, 16);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
