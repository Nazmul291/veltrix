import { describe, expect, it } from "vitest";
import { safeRedirect } from "./safe-redirect";

describe("safeRedirect", () => {
  it.each([
    ["/admin/providers", "/admin/providers"],
    ["/billing?tab=plans#top", "/billing?tab=plans#top"],
    ["/a/../b", "/b"],
    ["//evil.com", "/dashboard"],
    ["/\\evil.com", "/dashboard"],
    ["https://evil.com", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
    ["/\nSet-Cookie: x", "/dashboard"],
    ["", "/dashboard"],
    [undefined, "/dashboard"],
    [42, "/dashboard"],
  ])("%j → %s", (input, expected) => expect(safeRedirect(input)).toBe(expected));

  it("falls back to the dashboard by default, or to an explicit fallback", () => {
    expect(safeRedirect("//evil.com")).toBe("/dashboard");
    expect(safeRedirect("//evil.com", "/login")).toBe("/login");
  });
});
