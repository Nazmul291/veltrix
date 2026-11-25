import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

const load = () => import("./crypto.server");
const opts = { purpose: "credentials" as const, aad: "provider-credential:FLY:apiToken:v1" };

describe("crypto.server", () => {
  it("round-trips plaintext", async () => {
    const { encrypt, decrypt } = await load();
    const secret = "fo1_" + randomBytes(24).toString("base64url");
    expect(decrypt(encrypt(secret, opts), opts)).toBe(secret);
  });

  it("uses a fresh IV per encryption", async () => {
    const { encrypt } = await load();
    const a = encrypt("same", opts);
    const b = encrypt("same", opts);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects mismatched AAD (row swap)", async () => {
    const { encrypt, decrypt, DecryptionError } = await load();
    const enc = encrypt("secret", opts);
    expect(() => decrypt(enc, { ...opts, aad: "provider-credential:FLY:apiToken:v2" })).toThrow(DecryptionError);
  });

  it("rejects tampered ciphertext and truncated tags", async () => {
    const { encrypt, decrypt, DecryptionError } = await load();
    const enc = encrypt("secret-value", opts);
    const ct = Buffer.from(enc.ciphertext, "base64");
    ct[0] ^= 0xff;
    expect(() => decrypt({ ...enc, ciphertext: ct.toString("base64") }, opts)).toThrow(DecryptionError);
    const shortTag = Buffer.from(enc.authTag, "base64").subarray(0, 4).toString("base64");
    expect(() => decrypt({ ...enc, authTag: shortTag }, opts)).toThrow(DecryptionError);
  });

  it("isolates purposes via HKDF", async () => {
    const { encrypt, decrypt, DecryptionError } = await load();
    const enc = encrypt("secret", opts);
    expect(() => decrypt(enc, { ...opts, purpose: "resource-secrets" })).toThrow(DecryptionError);
  });

  it("fingerprints deterministically without containing the secret", async () => {
    const { fingerprint } = await load();
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
    expect(fingerprint("abc")).toMatch(/^[0-9a-f]{16}$/);
  });
});
