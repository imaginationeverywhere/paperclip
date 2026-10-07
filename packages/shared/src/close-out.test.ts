import { describe, expect, it } from "vitest";
import { formatCloseOutComment } from "./index.js";

describe("formatCloseOutComment", () => {
  it("renders PR url with head SHA", () => {
    const body = formatCloseOutComment({
      did: "Fixed the thing",
      prUrl: "https://github.com/org/repo/pull/1",
      headSha: "abc123",
      left: "Nothing",
    });

    expect(body).toContain("**DID:** Fixed the thing");
    expect(body).toContain("**PR:** https://github.com/org/repo/pull/1 (`abc123`)");
    expect(body).toContain("**LEFT:** Nothing");
  });

  it("falls back to a bare head SHA when there is no PR url", () => {
    const body = formatCloseOutComment({ did: "Investigated only", headSha: "abc123" });
    expect(body).toContain("**PR:** `abc123`");
  });

  it("omits the PR line entirely when neither prUrl nor headSha is given", () => {
    const body = formatCloseOutComment({ did: "Pure investigation, no commit" });
    expect(body).not.toContain("**PR:**");
  });

  it("defaults LEFT to 'Nothing outstanding.' when blank, missing, or whitespace-only", () => {
    expect(formatCloseOutComment({ did: "x" })).toContain("**LEFT:** Nothing outstanding.");
    expect(formatCloseOutComment({ did: "x", left: "" })).toContain("**LEFT:** Nothing outstanding.");
    expect(formatCloseOutComment({ did: "x", left: "   " })).toContain("**LEFT:** Nothing outstanding.");
  });
});
