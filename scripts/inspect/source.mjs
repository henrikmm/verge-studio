// Finding a run on this disk, and reading what it holds.
//
// Two kinds of run are inspectable and they are deliberately addressed the same way: the
// committed fixtures under `fixtures/`, and whatever the operator saved into `~/verge-runs`.
// The ids match the ones the app's run registry uses (`door-504px-112f`, `roadside`, and the
// timestamped directory name for a saved run), so a run named in the interface, in the Registry
// or in a review log can be pasted straight into this tool.
//
// Nothing here touches the network. There is no code path from the inspector to the cloud, by
// construction rather than by discipline — which is what makes it safe to run at any time.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const FIXTURE_ROOT = join(REPO, "fixtures");
export const RUNS_ROOT = resolve(process.env.VERGE_RUNS_ROOT ?? join(homedir(), "verge-runs"));

/** Where rendered images land. Gitignored: a 900×900 PNG is evidence, not a commit. */
export const OUT_ROOT = resolve(process.env.VERGE_INSPECT_OUT ?? join(REPO, ".inspect"));

const CLOUD_FILE = "scene.glb";
const NPZ_FILES = ["verge-result.npz", "result.npz"];

/**
 * Every run this machine can inspect, fixtures first.
 *
 * A directory qualifies when it holds a `scene.glb`, which is the one artefact every command
 * here needs. A run whose payload was never saved — the manifest-only stubs the app registers
 * after a cloud run — is skipped rather than listed and then failing on use.
 */
export function listRuns() {
  const runs = [];

  for (const group of directories(FIXTURE_ROOT)) {
    const groupPath = join(FIXTURE_ROOT, group);
    if (existsSync(join(groupPath, CLOUD_FILE))) {
      runs.push(describe(group, groupPath, "fixture"));
      continue;
    }
    for (const setting of directories(groupPath)) {
      const settingPath = join(groupPath, setting);
      if (existsSync(join(settingPath, CLOUD_FILE))) {
        runs.push(describe(`${group}-${setting}`, settingPath, "fixture"));
      }
    }
  }

  for (const id of directories(RUNS_ROOT)) {
    const path = join(RUNS_ROOT, id);
    if (existsSync(join(path, CLOUD_FILE))) runs.push(describe(id, path, "saved"));
  }

  return runs;
}

/**
 * The run an id names.
 *
 * Unique prefixes resolve, because saved runs are named by timestamp and hash and nobody types
 * `20260806-173802-d354a2` correctly twice. An ambiguous prefix is an error rather than a guess:
 * silently inspecting the wrong run would poison every number downstream of it.
 */
export function resolveRun(id) {
  const runs = listRuns();
  if (!id) {
    throw new Error(`no run named. Available: ${runs.map((r) => r.id).join(", ") || "none"}`);
  }

  const exact = runs.find((run) => run.id === id);
  if (exact) return exact;

  const matches = runs.filter((run) => run.id.startsWith(id) || run.id.includes(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`"${id}" matches ${matches.map((r) => r.id).join(", ")} — be specific`);
  }
  throw new Error(`no run "${id}". Available: ${runs.map((r) => r.id).join(", ") || "none"}`);
}

function describe(id, path, kind) {
  const npz = NPZ_FILES.map((name) => join(path, name)).find(existsSync) ?? null;
  return {
    id,
    kind,
    path,
    glb: join(path, CLOUD_FILE),
    npz,
    manifestPath: existsSync(join(path, "manifest.json")) ? join(path, "manifest.json") : null,
    frames: resolveFrameDirectory(path, frameCountOf(path)),
  };
}

function directories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith("."))
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort();
}

function frameCountOf(path) {
  const manifestPath = join(path, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return manifest.frames?.count ?? null;
  } catch {
    return null;
  }
}

/**
 * The directory of source JPEGs for a run, or null.
 *
 * The fixtures keep one shared pool of frames per clip with a subdirectory per sampling
 * (`fixtures/door/frames/f-112`), because the same video sampled two ways is still the same
 * video; a saved run keeps its own `frames/`. The count is what disambiguates them, and getting
 * this wrong is not cosmetic — this repository has already lost time to a mask painted on one
 * frame and back-projected with another frame's camera.
 */
function resolveFrameDirectory(path, count) {
  const candidates = [
    count ? join(path, "frames", `f-${count}`) : null,
    join(path, "frames"),
    count ? join(path, "..", "frames", `f-${count}`) : null,
    join(path, "..", "frames"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const jpegs = frameFiles(candidate);
    if (jpegs.length === 0) continue;
    if (count && jpegs.length !== count) continue;
    return candidate;
  }
  return null;
}

/** Frame JPEGs in numeric order. Sorted by the number in the name, never by string. */
export function frameFiles(directory) {
  if (!directory || !existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /\.jpe?g$/i.test(name))
    .map((name) => ({ name, index: Number(name.match(/(\d+)/)?.[1] ?? -1) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((entry) => join(directory, entry.name));
}

/** The run's manifest, or null. Keys are read as written; both cases appear in the wild. */
export function readManifest(run) {
  if (!run.manifestPath) return null;
  return JSON.parse(readFileSync(run.manifestPath, "utf8"));
}

/** First present of several spellings. Manifests on disk are snake_case, in the app camelCase. */
export function pick(object, ...names) {
  for (const name of names) {
    if (object && object[name] !== undefined && object[name] !== null) return object[name];
  }
  return undefined;
}

/**
 * The point cloud, its colours, the camera frusta and the scene alignment, straight from the GLB.
 *
 * Read by hand rather than through a glTF library for the same reason the fixture test does it:
 * the file is one mesh of points plus one line loop per recorded camera, and parsing it here
 * keeps the inspector free of Three.js — which would drag in a renderer this tool does not use.
 *
 * `alignment` is the transform DA3 records under `hf_alignment`, mapping its raw reconstruction
 * frame to the one the GLB's positions are already in. Points here are therefore in DISPLAY
 * space; anything that has to meet a camera again must go back through its inverse.
 */
export function readCloud(glbPath) {
  const buffer = readFileSync(glbPath);
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error(`${glbPath}: not a GLB`);
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error(`${glbPath}: truncated GLB`);

  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8"));
  const binOffset = 20 + jsonLength + 8;

  const read = (accessorIndex) => {
    const accessor = gltf.accessors[accessorIndex];
    const view = gltf.bufferViews[accessor.bufferView];
    const start = binOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
    const length = accessor.count * components;
    const base = buffer.buffer;
    const at = buffer.byteOffset + start;

    if (view.byteStride && view.byteStride !== components * sizeOf(accessor.componentType)) {
      throw new Error("interleaved GLB attributes are not supported");
    }
    if (accessor.componentType === 5126) return new Float32Array(base.slice(at, at + length * 4));
    if (accessor.componentType === 5121) return new Uint8Array(base.slice(at, at + length));
    if (accessor.componentType === 5123) return new Uint16Array(base.slice(at, at + length * 2));
    throw new Error(`unsupported componentType ${accessor.componentType}`);
  };

  let points = null;
  let colors = null;
  const frusta = [];

  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const position = primitive.attributes?.POSITION;
      if (position === undefined) continue;

      // mode 0 is POINTS — the reconstruction. Everything else DA3 writes is line geometry,
      // and every line loop in this file is one recorded camera's frustum.
      if (primitive.mode === 0) {
        const candidate = read(position);
        if (!points || candidate.length > points.length) {
          points = candidate;
          colors = primitive.attributes.COLOR_0 !== undefined
            ? read(primitive.attributes.COLOR_0)
            : null;
        }
      } else {
        frusta.push(read(position));
      }
    }
  }

  if (!points) throw new Error(`${glbPath}: no POINTS primitive`);

  const alignment = gltf.scenes?.[gltf.scene ?? 0]?.extras?.hf_alignment;
  return {
    points,
    colors,
    frusta,
    count: points.length / 3,
    alignment: alignment ? alignment.flat() : null,
  };
}

function sizeOf(componentType) {
  return { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[componentType] ?? 4;
}

/** The npz arrays: depth, confidence, intrinsics, extrinsics. ~0.5 s and ~100 MB, so call once. */
export async function readArrays(run) {
  if (!run.npz) throw new Error(`run ${run.id} has no npz — depth and cameras are unavailable`);
  const { parseNpz } = await (await import("./typed.mjs")).typed();
  const file = readFileSync(run.npz);
  return parseNpz(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
}

/** A short label for the corner of a rendered image. */
export function label(run) {
  return `${run.id} ${basename(run.path)}`.slice(0, 64);
}
