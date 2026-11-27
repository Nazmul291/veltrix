import { describe, expect, it } from "vitest";
import { safeRedirect } from "./safe-redirect";

describe("safeRedirect", () => {
  it.each([
    ["/admin/providers", "/admin/providers"],
    ["/billing?tab=plans#top", "/billing?tab=plans#top"],
    ["/a/../b", "/b"],
    ["//evil.com", "/"],
    ["/\\evil.com", "/"],
    ["https://evil.com", "/"],
    ["javascript:alert(1)", "/"],
    ["/\nSet-Cookie: x", "/"],
    ["", "/"],
    [undefined, "/"],
    [42, "/"],
  ])("%j → %s", (input, expected) => expect(safeRedirect(input)).toBe(expected));
});
