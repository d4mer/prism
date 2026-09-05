import { describe, expect, it } from "vitest";
import { exposureWarning, isLoopbackHost } from "../src/security-warning.js";

describe("isLoopbackHost", () => {
  it("recognizes the standard loopback spellings", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("does not treat a LAN/all-interfaces bind as loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.50")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
  });
});

describe("exposureWarning (PRISM-19 acceptance criterion 2)", () => {
  it("warns when bound non-loopback with no token", () => {
    const warning = exposureWarning("0.0.0.0", undefined, 3800);
    expect(warning).toMatch(/no AUTH_TOKEN set/);
    expect(warning).toMatch(/0\.0\.0\.0:3800/);
  });

  it("says nothing when a token is set, regardless of bind address", () => {
    expect(exposureWarning("0.0.0.0", "secret", 3800)).toBeNull();
    expect(exposureWarning("192.168.1.50", "secret", 3800)).toBeNull();
  });

  it("says nothing when bound to loopback with no token (the safe local default)", () => {
    expect(exposureWarning("127.0.0.1", undefined, 3800)).toBeNull();
    expect(exposureWarning("localhost", undefined, 3800)).toBeNull();
  });

  it("still warns for a LAN address even with no token, distinct from loopback", () => {
    expect(exposureWarning("192.168.1.50", undefined, 3800)).toMatch(/no AUTH_TOKEN set/);
  });

  it("never includes the bundle root or any filesystem path", () => {
    const warning = exposureWarning("0.0.0.0", undefined, 3800) ?? "";
    expect(warning).not.toMatch(/\/(home|Users|var|tmp)\//);
  });
});
