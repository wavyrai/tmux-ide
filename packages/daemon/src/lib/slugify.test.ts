import { describe, it, expect } from "bun:test";
import { slugify } from "./slugify.ts";

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("collapses multiple non-alphanumeric chars into one hyphen", () => {
    expect(slugify("foo---bar   baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("defaults to maxLen 40", () => {
    const long = "a".repeat(60);
    expect(slugify(long)).toHaveLength(40);
  });

  it("respects custom maxLen", () => {
    const long = "a".repeat(60);
    expect(slugify(long, 50)).toHaveLength(50);
    expect(slugify(long, 30)).toHaveLength(30);
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles special characters", () => {
    expect(slugify("feat: add @auth/login!")).toBe("feat-add-auth-login");
  });
});
