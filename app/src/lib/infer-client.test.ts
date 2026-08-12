import { describe, expect, it } from "vitest";
import { isLocalApiBase } from "./infer-client";

describe("local inference API detection", () => {
  it("protects both the mock root and nested local proxy routes", () => {
    expect(isLocalApiBase("/api")).toBe(true);
    expect(isLocalApiBase("/api/cloud/svc")).toBe(true);
  });

  it("does not attach the local nonce to remote services", () => {
    expect(isLocalApiBase("https://example.run.app")).toBe(false);
    expect(isLocalApiBase("/application")).toBe(false);
  });
});
