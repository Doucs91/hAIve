import { describe, expect, it } from "vitest";
import { compareVersions } from "../src/index.js";

/** Three byte-identical copies of this existed before it was extracted; ordering must not fork. */
describe("compareVersions", () => {
  it("orders by numeric component, not lexically", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.57.3")).toBeGreaterThan(0);
    expect(compareVersions("0.57.3", "0.57.3")).toBe(0);
  });

  it("pads missing components with zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("does not throw on input it cannot parse — an advisory check must not crash the gate", () => {
    expect(() => compareVersions("not-a-version", "0.1.0")).not.toThrow();
    expect(compareVersions("", "")).toBe(0);
  });
});
