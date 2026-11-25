import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPaddleSignature } from "./paddle.server";

const secret = "pdl_ntfset_test_secret";
const body = '{"event_id":"evt_1","event_type":"subscription.created","data":{}}';
const now = 1_800_000_000;
const sign = (ts: number, payload = body, key = secret) => createHmac("sha256", key).update(`${ts}:${payload}`).digest("hex");

describe("verifyPaddleSignature", () => {
  it("accepts a valid signature", () => {
    expect(verifyPaddleSignature(body, `ts=${now};h1=${sign(now)}`, secret, now)).toBe(true);
  });

  it("accepts any of several h1 values (secret rotation)", () => {
    const header = `ts=${now};h1=${sign(now, body, "old-secret")};h1=${sign(now)}`;
    expect(verifyPaddleSignature(body, header, secret, now)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and timestamps outside the window", () => {
    expect(verifyPaddleSignature(body + " ", `ts=${now};h1=${sign(now)}`, secret, now)).toBe(false);
    expect(verifyPaddleSignature(body, `ts=${now};h1=${sign(now, body, "nope")}`, secret, now)).toBe(false);
    expect(verifyPaddleSignature(body, `ts=${now - 301};h1=${sign(now - 301)}`, secret, now)).toBe(false);
    expect(verifyPaddleSignature(body, `ts=${now + 301};h1=${sign(now + 301)}`, secret, now)).toBe(false);
  });

  it("rejects malformed headers", () => {
    for (const h of [null, "", "h1=abc", `ts=${now}`, `ts=abc;h1=${sign(now)}`, `ts=${now};h1=zz`, `ts=${now};h1=${sign(now).slice(0, 10)}`]) {
      expect(verifyPaddleSignature(body, h, secret, now)).toBe(false);
    }
  });
});
