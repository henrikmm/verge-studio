// Fixture smoke: asserts a fixture directory is present and structurally sane.
// Pure Node built-ins, no deps. Part of scripts/verify.sh.
//
// Default (no args): the roadside fixture, with its full expected file set.
// `--dir <path>`:     validate whatever a run actually produced. Used before teardown
//                     to prove a cloud run's artifacts arrived intact while there is
//                     still a live instance to re-download them from.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const argv = process.argv.slice(2);
const dirFlag = argv.indexOf("--dir");
const dir =
  dirFlag === -1
    ? join(import.meta.dirname, "..", "fixtures", "roadside")
    : argv[dirFlag + 1];
const strict = dirFlag === -1; // only roadside has a known-complete file set

assert.ok(dir && existsSync(dir), `missing fixture dir: ${dir}`);

const present = new Set(readdirSync(dir));
const has = (name) => present.has(name);
const notes = [];

// manifest
assert.ok(has("manifest.json"), "no manifest.json");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
assert.ok(
  manifest.model_key ?? manifest.model ?? manifest.artifacts,
  "manifest lacks expected fields",
);

// PLY: ascii-parse header, assert vertex count
let vertices = null;
const plyName = [...present].find((n) => n.endsWith(".ply"));
if (plyName) {
  const ply = readFileSync(join(dir, plyName));
  const header = ply.subarray(0, 2048).toString("latin1");
  const m = header.match(/element vertex (\d+)/);
  assert.ok(m, `${plyName}: PLY header missing vertex element`);
  vertices = Number(m[1]);
  assert.ok(vertices > 1_000, `${plyName}: unexpectedly small point cloud: ${vertices}`);
  notes.push(`${vertices.toLocaleString()} pts (${plyName})`);
} else if (strict) {
  assert.fail("no .ply in fixture");
}

// GLB: magic + declared length matches file size. This is the check that catches a
// truncated download, which is the failure mode that matters after a cloud run.
const glbName = [...present].find((n) => n.endsWith(".glb"));
if (glbName) {
  const glb = readFileSync(join(dir, glbName));
  assert.equal(glb.readUInt32LE(0), 0x46546c67, `${glbName}: bad GLB magic`); // 'glTF'
  assert.equal(glb.readUInt32LE(8), glb.length, `${glbName}: GLB length mismatch (truncated?)`);
  notes.push(`glb ${(glb.length / 1e6).toFixed(1)} MB`);
} else if (strict) {
  assert.fail("no .glb in fixture");
}

// NPZ: zip signature + entry names from the central directory.
for (const npzName of [...present].filter((n) => n.endsWith(".npz"))) {
  const npz = readFileSync(join(dir, npzName));
  assert.equal(npz.readUInt16LE(0), 0x4b50, `${npzName} is not a zip`);
  const raw = npz.toString("latin1");
  const entries = [...raw.matchAll(/([A-Za-z0-9_\-.]+)\.npy/g)].map((m) => m[1]);
  const unique = [...new Set(entries)];

  // Only OUR npz is contractually required to carry these keys; DA3's native export
  // is whatever DA3 chose to write, and recording it is the point of keeping it.
  const isOurs = npzName === "result.npz" || npzName === "verge-result.npz";
  if (isOurs) {
    for (const n of ["depth", "confidence", "extrinsics", "intrinsics"]) {
      assert.ok(raw.includes(`${n}.npy`), `${npzName} missing entry: ${n}.npy`);
    }
  }
  notes.push(`${npzName} [${unique.join(", ")}]`);
}
if (strict) assert.ok([...present].some((n) => n.endsWith(".npz")), "no .npz in fixture");

// depth preview png
const pngName = [...present].find((n) => n.endsWith(".png"));
if (pngName) {
  const png = readFileSync(join(dir, pngName));
  assert.equal(png.readUInt32BE(0), 0x89504e47, `${pngName}: bad PNG magic`);
} else if (strict) {
  assert.fail("no .png in fixture");
}

console.log(`fixtures OK: ${notes.join(", ")}`);
if (!strict && has("SHA256SUMS")) console.log("  (SHA256SUMS present)");
