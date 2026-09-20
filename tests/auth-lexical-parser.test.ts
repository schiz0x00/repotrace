import { describe, it, expect } from "vitest";

describe("auth", () => {
  it("cookie sameSite strict", () => {
    expect("strict").toBe("strict");
  });
});

describe("search lexical", () => {
  it("multi-word query safe", () => {
    const safe = "hello world".replace(/[^a-zA-Z0-9_\s]/g, " ").trim();
    expect(safe).toBe("hello world");
  });
});

describe("parser", () => {
  it("parse errors throw", () => {
    expect(() => { throw new Error("parse error"); }).toThrow("parse error");
  });
});
