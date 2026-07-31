// Fixture smoke: asserts the offline dev fixture is present and structurally sane.
// Pure Node built-ins, no deps. Part of scripts/verify.sh.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = join(import.meta.dirname, "..", "fixtures", "roadside");
assert.ok(existsSync(dir), `missing fixture dir: ${dir}`);

// manifest
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
assert.ok(manifest.model_key ?? manifest.model ?? manifest.artifacts, "manifest lacks expected fields");

// PLY: ascii-parse header, assert vertex count
const ply = readFileSync(join(dir, "canonical-preview.ply"));
const header = ply.subarray(0, 2048).toString("latin1");
const m = header.match(/element vertex (\d+)/);
assert.ok(m, "PLY header missing vertex element");
const vertices = Number(m[1]);
assert.ok(vertices > 100_000, `unexpectedly small point cloud: ${vertices}`);

// GLB: magic + declared length matches file size
const glb = readFileSync(join(dir, "scene.glb"));
assert.equal(glb.readUInt32LE(0), 0x46546c67, "bad GLB magic"); // 'glTF'
assert.equal(glb.readUInt32LE(8), glb.length, "GLB length mismatch");

// NPZ: zip signature + expected entry names in central directory
const npz = readFileSync(join(dir, "result.npz"));
assert.equal(npz.readUInt16LE(0), 0x4b50, "result.npz is not a zip");
const names = ["depth", "confidence", "extrinsics", "intrinsics"];
const raw = npz.toString("latin1");
for (const n of names) assert.ok(raw.includes(`${n}.npy`), `npz missing entry: ${n}.npy`);

// depth preview png
const png = readFileSync(join(dir, "depth-preview.png"));
assert.equal(png.readUInt32BE(0), 0x89504e47, "bad PNG magic");

console.log(`fixtures OK: ${vertices.toLocaleString()} pts, glb ${(glb.length / 1e6).toFixed(1)} MB, npz entries [${names.join(", ")}]`);
