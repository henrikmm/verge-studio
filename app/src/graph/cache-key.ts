/**
 * Content-addressed cache keys for the node graph.
 *
 * A TypeScript port of `donor/content-hash.js`, which is the reference implementation.
 * The port is held byte-identical by `cache-key.test.ts`, which checks our digests
 * against golden vectors generated from the donor file itself (see
 * `scripts/gen-cache-key-vectors.mjs`). App code never imports `donor/`.
 *
 * CONTENT_HASH_CONTRACT_VERSION keeps the donor's value deliberately: it is part of
 * the hashed payload, so changing it would change every digest and make the parity
 * check meaningless. It is the same algorithm over the same contract.
 *
 * SHA-256 is the synchronous pure-JS implementation rather than `crypto.subtle`,
 * because cache keys are recomputed on every store read to decide which nodes are
 * stale — an async digest would turn that into a promise cascade through the UI.
 */

export const CONTENT_HASH_CONTRACT_VERSION = "mvl.schema-contracts/0.2.0";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** Synchronous SHA-256 over UTF-8 text or raw bytes. Lowercase hex digest. */
export function sha256Hex(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;

  const bitLength = BigInt(bytes.length) * 8n;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const block = new Uint8Array(paddedLength);
  block.set(bytes);
  block[bytes.length] = 0x80;
  const view = new DataView(block.buffer);
  view.setBigUint64(paddedLength - 8, bitLength);

  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return [...h].map((word) => word.toString(16).padStart(8, "0")).join("");
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Deterministic JSON: object keys sorted, no whitespace, non-finite numbers rejected. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export interface CacheIdentity {
  producerNode: string;
  producerVersion: string;
  /** Port name → 64-char lowercase SHA-256 of what arrives on that port. */
  inputContentSha256: Record<string, string>;
  parameters?: Record<string, JsonValue>;
}

/**
 * The identity of a node's output: who produced it, at what version, from which
 * inputs, under which parameters. Equal keys mean the result can be reused;
 * a differing key means the node — and everything downstream — must re-run.
 */
export function artifactCacheKey(identity: CacheIdentity): string {
  if (!identity.producerNode || !identity.producerVersion) {
    throw new TypeError("cache identity must declare producer provenance");
  }
  for (const [input, digest] of Object.entries(identity.inputContentSha256)) {
    if (!SHA256_PATTERN.test(digest)) {
      throw new TypeError(`${input} must contain a lowercase SHA-256 digest`);
    }
  }
  return sha256Hex(
    canonicalJson({
      contract_version: CONTENT_HASH_CONTRACT_VERSION,
      input_content_sha256: identity.inputContentSha256,
      parameters: identity.parameters ?? {},
      producer_node: identity.producerNode,
      producer_version: identity.producerVersion,
    }),
  );
}
