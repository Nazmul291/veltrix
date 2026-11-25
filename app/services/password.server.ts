/**
 * Password hashing with Node's built-in scrypt (memory-hard, no native dependency).
 * Stored format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 * The parameters travel with each hash, so they can be raised later without
 * breaking existing users: needsRehash() flags hashes made with old parameters.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 64;
const SALT_LEN = 16;
// scrypt needs about 128 * N * r bytes; Node's default 32 MB cap is too small for N=2^15.
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEY_LEN, { ...PARAMS, maxmem: MAXMEM });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function needsRehash(stored: string): boolean {
  const [, n, r, p] = stored.split("$");
  return Number(n) !== PARAMS.N || Number(r) !== PARAMS.r || Number(p) !== PARAMS.p;
}

/**
 * A fixed hash to verify against when the email doesn't exist, so "no such user"
 * and "wrong password" take the same time and can't be told apart.
 */
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  return dummyHash;
}
