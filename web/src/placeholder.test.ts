import { describe, expect, it } from "vitest";
import { placeholder } from "./placeholder";

describe("placeholder", () => {
  it("returns the package name", () => {
    expect(placeholder()).toBe("web");
  });
});
