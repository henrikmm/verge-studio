#!/usr/bin/env node
// Generate golden cache-key vectors FROM the donor implementation, so the TS port in
// app/src/graph/cache-key.ts can be proven byte-identical without app code ever
// importing donor/ (which CLAUDE.md forbids).
//
// Regenerate with:  node scripts/gen-cache-key-vectors.mjs
// The donor is read-only; this script only reads it.

import { writeFileSync } from "node:fs";
import { artifactCacheKey, canonicalJson, sha256Hex } from "../donor/content-hash.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

// Cases chosen to pin down the parts a port can plausibly get wrong: key ordering,
// empty vs absent parameters, nested structures, unicode, and number formatting.
const identities = [
  { producer_node: "frame-source", producer_version: "0.1.0", input_content_sha256: {} },
  {
    producer_node: "frame-source",
    producer_version: "0.1.0",
    input_content_sha256: {},
    parameters: {},
  },
  {
    producer_node: "da3-depth",
    producer_version: "0.1.0",
    input_content_sha256: { frames: A },
    parameters: { fps: 10, process_res: 504, infer_gs: false },
  },
  {
    // Same parameters, declared in a different source order: canonical JSON sorts
    // keys, so this MUST produce the digest above.
    producer_node: "da3-depth",
    producer_version: "0.1.0",
    input_content_sha256: { frames: A },
    parameters: { infer_gs: false, process_res: 504, fps: 10 },
  },
  {
    producer_node: "point-cloud",
    producer_version: "0.2.0",
    input_content_sha256: { depth: A, camera: B },
    parameters: { stride: 2, conf_percentile: 0.5, label: "café ☕", nested: { a: [1, 2, null] } },
  },
  {
    producer_node: "da3-depth",
    producer_version: "0.1.0",
    input_content_sha256: { frames: A },
    parameters: { fps: 10.0, negative_zero: -0, big: 1e21 },
  },
];

const vectors = {
  _comment:
    "Golden vectors generated from donor/content-hash.js by scripts/gen-cache-key-vectors.mjs. " +
    "Do not hand-edit. The donor is the reference implementation for cache keys.",
  contract_version: "mvl.schema-contracts/0.2.0",
  sha256: [
    { input: "", digest: sha256Hex("") },
    { input: "abc", digest: sha256Hex("abc") },
    // Crosses the 55/56-byte padding boundary, where naive implementations break.
    { input: "a".repeat(55), digest: sha256Hex("a".repeat(55)) },
    { input: "a".repeat(56), digest: sha256Hex("a".repeat(56)) },
    { input: "a".repeat(64), digest: sha256Hex("a".repeat(64)) },
    { input: "verge-studio ☕ é 日本語", digest: sha256Hex("verge-studio ☕ é 日本語") },
  ],
  canonical_json: [
    { value: { b: 1, a: 2 }, text: canonicalJson({ b: 1, a: 2 }) },
    { value: [1, "two", null, true], text: canonicalJson([1, "two", null, true]) },
    { value: { z: { y: 1, x: 2 } }, text: canonicalJson({ z: { y: 1, x: 2 } }) },
  ],
  cache_keys: identities.map((identity) => ({ identity, digest: artifactCacheKey(identity) })),
};

const out = new URL("../app/src/graph/cache-key-vectors.json", import.meta.url);
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${vectors.cache_keys.length} cache keys + ${vectors.sha256.length} digests`);
