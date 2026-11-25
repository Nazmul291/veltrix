import { describe, expect, it } from "vitest";
import { safeRedirect } from "~/lib/schemas/auth";
import { hashPassword, needsRehash, verifyPassword } from "./password.server";

describe("password.server", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", h)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same-password-123")).not.toBe(await hashPassword("same-password-123"));
  });

  it("rejects malformed hashes and flags old parameters", async () => {
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
    expect(needsRehash("scrypt$16384$8$1$a$b")).toBe(true);
    expect(needsRehash(await hashPassword("abcdefghijkl"))).toBe(false);
  });
});

describe("safeRedirect", () => {
  it.each([
    ["/admin/providers", "/admin/providers"],
    ["//evil.com", "/"],
    ["/\\evil.com", "/"],
    ["https://evil.com", "/"],
    [undefined, "/"],
  ])("%s → %s", (input, expected) => expect(safeRedirect(input)).toBe(expected));
});
