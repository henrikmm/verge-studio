import { describe, expect, it } from "vitest";
import {
  artifactCacheKey,
  canonicalJson,
  CONTENT_HASH_CONTRACT_VERSION,
  sha256Hex,
  type CacheIdentity,
  type JsonValue,
} from "./cache-key";
import vectors from "./cache-key-vectors.json";

/**
 * The golden vectors come from `donor/content-hash.js` via
 * `scripts/gen-cache-key-vectors.mjs`. If these fail, the TS port has drifted from
 * the reference implementation and every cache key in the app is suspect.
 */
describe("parity with the donor implementation", () => {
  it("agrees on the contract version that goes into every digest", () => {
    expect(CONTENT_HASH_CONTRACT_VERSION).toBe(vectors.contract_version);
  });

  it("reproduces the donor's SHA-256 digests", () => {
    for (const { input, digest } of vectors.sha256) {
      expect(sha256Hex(input), `sha256(${JSON.stringify(input.slice(0, 24))})`).toBe(digest);
    }
  });

  it("reproduces the donor's canonical JSON", () => {
    for (const { value, text } of vectors.canonical_json) {
      expect(canonicalJson(value as JsonValue)).toBe(text);
    }
  });

  it("reproduces the donor's cache keys", () => {
    for (const { identity, digest } of vectors.cache_keys) {
      // The vectors are the donor's snake_case wire shape; TS infers a union of
      // per-case object literals from the JSON, so widen it back to the contract.
      const raw = identity as {
        producer_node: string;
        producer_version: string;
        input_content_sha256: Record<string, string>;
        parameters?: Record<string, JsonValue>;
      };
      const ported: CacheIdentity = {
        producerNode: raw.producer_node,
        producerVersion: raw.producer_version,
        inputContentSha256: raw.input_content_sha256,
        parameters: raw.parameters,
      };
      expect(artifactCacheKey(ported), identity.producer_node).toBe(digest);
    }
  });
});

describe("sha256Hex", () => {
  it("matches the published SHA-256 of the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes bytes and their UTF-8 text identically", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
});

describe("canonicalJson", () => {
  it("sorts object keys so declaration order cannot change a digest", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("rejects non-finite numbers rather than emitting null", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});

describe("artifactCacheKey", () => {
  const base: CacheIdentity = {
    producerNode: "da3-depth",
    producerVersion: "0.1.0",
    inputContentSha256: { frames: "a".repeat(64) },
    parameters: { fps: 10 },
  };

  it("is stable across repeated calls", () => {
    expect(artifactCacheKey(base)).toBe(artifactCacheKey(base));
  });

  it("changes when a parameter changes", () => {
    expect(artifactCacheKey({ ...base, parameters: { fps: 11 } })).not.toBe(artifactCacheKey(base));
  });

  it("changes when an input digest changes", () => {
    const other = { ...base, inputContentSha256: { frames: "b".repeat(64) } };
    expect(artifactCacheKey(other)).not.toBe(artifactCacheKey(base));
  });

  it("changes when the producer version changes, so a code fix invalidates cache", () => {
    expect(artifactCacheKey({ ...base, producerVersion: "0.2.0" })).not.toBe(
      artifactCacheKey(base),
    );
  });

  it("treats absent and empty parameters as the same thing", () => {
    const withInputs = { producerNode: "n", producerVersion: "1", inputContentSha256: {} };
    expect(artifactCacheKey(withInputs)).toBe(artifactCacheKey({ ...withInputs, parameters: {} }));
  });

  it("rejects an input digest that is not a lowercase sha256", () => {
    const bad = { ...base, inputContentSha256: { frames: "A".repeat(64) } };
    expect(() => artifactCacheKey(bad)).toThrow(/lowercase SHA-256/);
    expect(() => artifactCacheKey({ ...base, inputContentSha256: { frames: "abc" } })).toThrow();
  });

  it("rejects missing producer provenance", () => {
    expect(() => artifactCacheKey({ ...base, producerNode: "" })).toThrow(/provenance/);
    expect(() => artifactCacheKey({ ...base, producerVersion: "" })).toThrow(/provenance/);
  });
});
