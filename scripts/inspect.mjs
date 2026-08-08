#!/usr/bin/env node
// The inspector: look at a reconstruction without opening the app.
//
// Most questions asked of this project are not questions about the interface. "Why is this
// measurement 12 cm short", "is the floor under the tower or through it", "did the clip actually
// move", "is that patch really grass" — none of those are answered by a screenshot of a docked
// pane, and all of them were being answered that way, through a browser, a dev server and a
// sequence of clicks, because that was the only door in.
//
// This is the other door. It reads the same fixtures and saved runs the app reads, calls the same
// geometry the app calls, and prints numbers or draws pictures. Both, usually: a support fraction
// with no picture of the plane it describes is a number you have to trust, and a picture with no
// numbers is an impression.
//
// Three properties are load-bearing:
//
//   1. **It cannot spend money.** There is no network code here at all. Run it whenever.
//   2. **It cannot disagree with the app.** Every geometric quantity comes from `geometry/`
//      through `inspect/bridge.ts`. Nothing is reimplemented, so nothing can drift.
//   3. **It draws evidence, not appearance.** Colour by height above the fitted floor, by plane
//      inlier, by what a selection actually caught — the things the viewport does not show.
//
// `node scripts/inspect.mjs` with no arguments prints the full command list.

import { basename, relative, resolve } from "node:path";
import { readImage, writePng } from "./inspect/image.mjs";
import {
  OUT_ROOT,
  REPO,
  frameFiles,
  listRuns,
  readArrays,
  readCloud,
  readManifest,
  resolveRun,
} from "./inspect/source.mjs";
import {
  COLOURS,
  VIEWS,
  apply4x4,
  contactSheet,
  depthImage,
  frameOverlay,
  maskOverlay,
  invert4x4,
  projectToPixel,
  renderCloud,
  viewBasis,
} from "./inspect/render.mjs";
import { typed } from "./inspect/typed.mjs";

const HELP = `
verge inspect — read a reconstruction from this disk. Never touches the cloud.

  node scripts/inspect.mjs <command> [run] [options]

COMMANDS
  runs                       every fixture and saved run this machine can inspect
  run <id>                   what the run is: frames, sampling, pixels per frame, model, cost
  cloud <id>                 what is in the point cloud: count, extent, up axis, camera track
  floor <id>                 fit the ground plane and report it, including the runner-up margin
  view <id>                  draw the cloud            --view / --colour / --cameras
  frames <id>                draw the source frames as one numbered contact sheet
  depth <id>                 draw one frame's depth, colour-mapped as Depth 2D maps it
  coverage <id>              what of the picture never reached the cloud, and why
  select <id>                choose points and SEE them: in the cloud and on the photograph
  explain <id>               the whole chain, numbers and pictures, in one go

RUN IDS
  A unique prefix is enough. Fixtures are <clip>-<setting> (door-504px-112f, roadside);
  saved runs use the directory name under ~/verge-runs.

OPTIONS
  --json                     machine-readable output instead of the aligned table
  --out <path>               where to write an image (default .inspect/)
  --view <name>              ${VIEWS.join(" | ")}            (default top)
  --colour <name>            ${COLOURS.join(" | ")}    (default rgb)
  --cameras                  draw the recorded camera track over the cloud
  --size <px>                image size, default 900
  --every <n>                draw only every nth point, for a faster picture (default 1)
  --frame <n>                which frame (depth, select overlay); "auto" picks the best
  --band <lo,hi>             select points this many metres above the fitted floor
  --near <x,y,z> --radius <m>  select points within a sphere, display-space metres
  --columns <n> --max <n>    contact sheet shape (default 8 columns, 48 frames)
  --confidence               shade the depth image by DA3's confidence
  --voxel <m>                coverage: how close a cloud point must be to count (default 0.08)
  --cloud <glb|npz>          which cloud to work on. npz rebuilds it from the depth maps with
                             no confidence floor, at the GLB's own point count (default glb)
  --conf <value>             confidence floor for --cloud npz (default 0, keep everything)
  --height-range <lo,hi>     colour ramp limits for --colour height (default 0,2)
  --floor-band <lo,hi>       the slice --view floor shows, metres about the plane (default -0.3,0.9)
  --render                   have "floor" also draw the fit it just reported

GROUND-FIT OPTIONS  (defaults are the app's own, so the numbers match the interface)
  --inlier <m>               inlier band half-thickness      default 0.035
  --tilt <deg>               initial tilt gate               default 30
  --iterations <n>           RANSAC iterations               default 1200
  --stride <n>               fit stride                      default 16
                             (the fit only — use --every to thin a drawing)
  --seed <n>                 RANSAC seed                     default 7
  --repeat <n>               floor: fit n times changing ONLY the seed, and report the spread

EXAMPLES
  node scripts/inspect.mjs floor door-504px-112f
  node scripts/inspect.mjs view door-504px-112f --colour height --view top
  node scripts/inspect.mjs select door-504px-112f --band 0.02,0.6
  node scripts/inspect.mjs explain roadside
`;

const COMMANDS = {
  runs: cmdRuns,
  run: cmdRun,
  cloud: cmdCloud,
  floor: cmdFloor,
  view: cmdView,
  frames: cmdFrames,
  depth: cmdDepth,
  coverage: cmdCoverage,
  select: cmdSelect,
  explain: cmdExplain,
};

async function main() {
  const { command, positional, flags } = parse(process.argv.slice(2));
  if (!command || command === "help" || flags.help) {
    process.stdout.write(`${HELP.trim()}\n`);
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`unknown command "${command}". Try: ${Object.keys(COMMANDS).join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    await handler(positional, flags);
  } catch (error) {
    process.stderr.write(`inspect ${command}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

// ── commands ────────────────────────────────────────────────────────────────────────────────

async function cmdRuns(_positional, flags) {
  const runs = listRuns().map((run) => ({
    id: run.id,
    kind: run.kind,
    npz: Boolean(run.npz),
    frames: frameFiles(run.frames).length,
    path: rel(run.path),
  }));

  if (flags.json) return json({ runs });
  if (runs.length === 0) {
    return out("no inspectable runs. Fixtures live in fixtures/, saved runs in ~/verge-runs.");
  }
  out(table(["ID", "KIND", "NPZ", "FRAMES", "PATH"], runs.map((r) => [
    r.id,
    r.kind,
    r.npz ? "yes" : "—",
    r.frames || "—",
    r.path,
  ])));
}

async function cmdRun(positional, flags) {
  const run = resolveRun(positional[0]);
  const manifest = readManifest(run);
  if (!manifest) throw new Error(`run ${run.id} has no manifest.json`);

  const frames = manifest.frames ?? {};
  const params = manifest.params ?? {};
  const vram = manifest.vram ?? {};
  const timing = manifest.timing ?? {};
  const pixels = (frames.width ?? 0) * (frames.height ?? 0);
  const jpegs = frameFiles(run.frames);

  const facts = {
    run: `${run.id} (${run.kind})`,
    path: rel(run.path),
    model: `${manifest.model_repository_id ?? "?"} @ ${(manifest.model_revision ?? "?").slice(0, 7)}`,
    depth: `${manifest.depth_mode ?? "?"}, ${manifest.linear_unit ?? "?"}`,
    frames: `${frames.count ?? "?"} of ${frames.requested_count ?? "?"} requested, ${frames.width}x${frames.height} px`,
    "pixels/frame": pixels ? pixels.toLocaleString("en-GB") : "unknown",
    sampling: `${round(params.fps, 3)} fps over ${round(params.source_duration_s, 2)} s${frames.capped ? " (CAPPED)" : ""}`,
    "process res": `${params.process_res} (${params.process_res_method ?? "?"})`,
    "max frames": params.max_frames ?? "—",
    vram: vram.peak_bytes
      ? `${gib(vram.peak_bytes)} driver / ${gib(vram.torch_peak_bytes)} allocator on ${vram.device_name ?? "?"}`
      : "not recorded",
    timing: timing.gpu_seconds
      ? `${round(timing.gpu_seconds, 1)} s gpu, ${round(timing.wall_seconds, 1)} s wall`
      : "not recorded",
    artifacts: (manifest.artifacts ?? [])
      .map((a) => `${a.name} ${mb(a.size_bytes)}`)
      .join(", ") || "—",
    "source frames": jpegs.length ? `${jpegs.length} jpg in ${rel(run.frames)}` : "NOT ON THIS DISK",
    transient: manifest.transient ? `yes, expires after ${manifest.expires_after_days} days` : "no",
  };

  if (flags.json) return json({ id: run.id, path: run.path, manifest, pixelsPerFrame: pixels });
  out(pairs(facts));
}

async function cmdCloud(positional, flags) {
  const run = resolveRun(positional[0]);
  const s = await scene(run, flags, { fitFloor: false });
  const { cloud } = s;

  const stats = cloudStats(cloud.points);
  const alongUp = quantilesAlong(cloud.points, s.up.up, s.T);

  const facts = {
    run: `${run.id} (${run.kind})`,
    source: cloud.origin ?? "GLB, as DA3 exported it",
    points: `${cloud.count.toLocaleString("en-GB")}${stats.nonFinite ? `, ${stats.nonFinite} NOT FINITE` : ""}`,
    colour: cloud.colors ? "per-point RGB present" : "none in the GLB",
    "bounding box": `x [${round(stats.min[0], 2)}, ${round(stats.max[0], 2)}]  y [${round(stats.min[1], 2)}, ${round(stats.max[1], 2)}]  z [${round(stats.min[2], 2)}, ${round(stats.max[2], 2)}] m`,
    extent: `${round(stats.size[0], 2)} x ${round(stats.size[1], 2)} x ${round(stats.size[2], 2)} m, diagonal ${round(stats.diagonal, 2)} m`,
    centroid: `[${stats.centroid.map((v) => round(v, 2)).join(", ")}]`,
    "up axis": `${fmtVec(s.up.up)} from ${s.up.source}${s.gravity ? `, camera coherence ${round(s.gravity.coherence, 2)}` : ""}`,
    "along up": `p1 ${round(alongUp.p1, 2)}  p50 ${round(alongUp.p50, 2)}  p99 ${round(alongUp.p99, 2)} m (span ${round(alongUp.p99 - alongUp.p1, 2)})`,
    cameras: s.track
      ? `${s.track.length / 3} recorded, track ${round(s.trackLength, 2)} m long`
      : "no extrinsics on this run",
  };

  if (s.gravity && s.gravity.coherence < 0.7) {
    facts.warning = `camera up is incoherent (${round(s.gravity.coherence, 2)} < 0.70) — the app REFUSES to fit a floor here`;
  }

  if (flags.json) return json({ id: run.id, ...stats, alongUp, up: s.up });
  out(pairs(facts));
}

/**
 * Is this fit an answer, or a coin flip?
 *
 * RANSAC draws its candidate planes at random, so the seed is the one input that carries
 * no information about the scene. A fit that moves when only the seed moves is not
 * measuring the floor; it is picking one of several floors the evidence permits equally.
 * Nothing in this project has ever asked, and the outdoor run turns out to answer badly.
 *
 * Reported as a SPREAD rather than a standard deviation: with a handful of seeds the
 * extremes are what a person needs to see, and "the ground moved 18 cm depending on the
 * seed" is the sentence that matters.
 */
async function repeatFloor(run, flags, times) {
  const runs = [];
  for (let i = 0; i < times; i++) {
    const s = await scene(run, { ...flags, seed: 7 + i * 101 }, { fitFloor: true });
    runs.push({
      seed: 7 + i * 101,
      ok: Boolean(s.floor),
      elevation: s.floor?.elevation ?? null,
      tiltDeg: s.floor?.tiltDeg ?? null,
      inlierFraction: s.floor?.inlierFraction ?? null,
      separation: marginOf([...(s.floor?.hypotheses ?? [])].sort((a, b) => b.qualityScore - a.qualityScore))
        ?.separation ?? null,
      cloud: s.cloud.origin ?? "glb",
    });
  }

  const spread = (key) => {
    const values = runs.map((r) => r[key]).filter((v) => v !== null);
    if (values.length === 0) return null;
    return { min: Math.min(...values), max: Math.max(...values) };
  };

  return { runs, elevation: spread("elevation"), tiltDeg: spread("tiltDeg"), separation: spread("separation") };
}

async function cmdFloor(positional, flags) {
  const run = resolveRun(positional[0]);

  if (flags.repeat) {
    const times = Math.max(2, Math.floor(Number(flags.repeat)));
    const study = await repeatFloor(run, flags, times);
    if (flags.json) return json({ id: run.id, ...study });

    const refused = study.runs.filter((r) => !r.ok).length;
    out(pairs({
      run: `${run.id} (${run.kind})`,
      cloud: study.runs[0].cloud,
      seeds: `${times} fits, differing ONLY in the RANSAC seed`,
      refused: refused ? `${refused} of ${times} found no floor at all` : "none",
      elevation: study.elevation
        ? `${round(study.elevation.min, 3)} .. ${round(study.elevation.max, 3)} m — spread ${round((study.elevation.max - study.elevation.min) * 100, 1)} cm`
        : "no fit",
      tilt: study.tiltDeg
        ? `${round(study.tiltDeg.min, 2)} .. ${round(study.tiltDeg.max, 2)} deg — spread ${round(study.tiltDeg.max - study.tiltDeg.min, 2)} deg`
        : "no fit",
      separation: study.separation
        ? `${round(study.separation.min, 3)} .. ${round(study.separation.max, 3)}`
        : "no fit",
    }));
    out("");
    out(table(
      ["SEED", "ELEVATION", "TILT", "SUPPORT", "SEPARATION"],
      study.runs.map((r) => [
        r.seed,
        r.ok ? `${round(r.elevation, 3)} m` : "REFUSED",
        r.ok ? `${round(r.tiltDeg, 2)}d` : "—",
        r.ok ? pct(r.inlierFraction) : "—",
        r.separation === null ? "—" : round(r.separation, 3),
      ]),
    ));
    return;
  }

  const s = await scene(run, flags, { fitFloor: true });

  if (!s.floor) {
    const facts = {
      run: `${run.id} (${run.kind})`,
      fit: "REFUSED",
      reason: s.floorError ?? "no extrinsics, so no gravity prior and no fit",
    };
    if (flags.json) return json({ id: run.id, fit: null, reason: s.floorError });
    out(pairs(facts));
    process.exitCode = 3; // a refusal is a result, but not a success
    return;
  }

  const fit = s.floor;
  const ranked = [...(fit.hypotheses ?? [])].sort((a, b) => b.qualityScore - a.qualityScore);
  const margin = marginOf(ranked);

  const facts = {
    run: `${run.id} (${run.kind})`,
    fit: "OK",
    cloud: s.cloud.origin ?? `GLB, ${s.cloud.count.toLocaleString("en-GB")} points as DA3 exported them`,
    support: `${pct(fit.inlierFraction)} — ${fit.inlierCount.toLocaleString("en-GB")} of ${Math.ceil(s.cloud.count / Number(flags.stride ?? 16)).toLocaleString("en-GB")} points sampled at stride ${flags.stride ?? 16}`,
    tilt: `${round(fit.tiltDeg, 2)} deg off the camera-derived up${fit.tiltClamped ? ` — GATED at ${flags.tilt ?? 30}, refinement wanted more` : ""}`,
    rmse: `${round(fit.rmse * 100, 2)} cm`,
    "below plane": `${pct(fit.belowFraction)} of the cloud`,
    elevation: `${round(fit.elevation, 3)} m along up`,
    normal: fmtVec(fit.plane.normal),
    proposal: `${pct(fit.proposalFraction)} of the gravity-sorted cloud`,
    candidates: `${fit.candidatesConsidered.toLocaleString("en-GB")} RANSAC candidates, ${ranked.length} hypotheses`,
  };

  if (s.gravity && s.gravity.coherence < 0.7) {
    facts.warning = `camera up is incoherent (${round(s.gravity.coherence, 2)}) — the app would REFUSE before fitting`;
  }

  facts.margin = margin === null
    ? "only one hypothesis survived — nothing to compare against"
    : `separation ${round(margin.separation, 3)} (0 is a dead heat, 1 no contest) — quality ${round(margin.winnerQuality, 3)} against ${round(margin.runnerUpQuality, 3)} for the ${pct(margin.runnerUpProposal)} proposal`;

  if (flags.json) {
    return json({ id: run.id, fit: strip(fit), hypotheses: ranked.map(strip), margin });
  }

  out(pairs(facts));
  out("");
  out(table(
    ["", "PROPOSAL", "QUALITY", "SUPPORT", "TILT", "RMSE", "BELOW"],
    ranked.map((h, i) => [
      i === 0 ? "win" : "",
      pct(h.proposalFraction),
      h.qualityScore.toFixed(3),
      pct(h.fit.inlierFraction),
      `${h.fit.tiltDeg.toFixed(1)}d`,
      `${(h.fit.rmse * 100).toFixed(1)}cm`,
      pct(h.fit.belowFraction),
    ]),
  ));

  if (flags.render) {
    const path = await drawCloud(run, s, flags, {
      view: "front",
      colour: "inlier",
      suffix: "floor",
    });
    out("");
    out(`image  ${path}`);
  }
}

async function cmdView(positional, flags) {
  const run = resolveRun(positional[0]);
  const colour = flags.colour ?? "rgb";
  const s = await scene(run, flags, { fitFloor: colour !== "rgb" && colour !== "flat" });
  const path = await drawCloud(run, s, flags, { view: flags.view ?? "top", colour });
  if (flags.json) return json({ id: run.id, image: path });
  out(`image  ${path}`);
  if (s.floorError) out(`note   no floor fitted: ${s.floorError}`);
}

async function cmdFrames(positional, flags) {
  const run = resolveRun(positional[0]);
  const sheet = await buildContactSheet(run, flags);
  if (flags.json) return json({ id: run.id, ...sheet });
  out(`image  ${sheet.image}`);
  out(`frames ${sheet.total} on disk, ${sheet.shown} drawn`);
}

async function buildContactSheet(run, flags) {
  const files = frameFiles(run.frames);
  if (files.length === 0) {
    throw new Error(`run ${run.id} has no source frames on this disk (looked beside ${rel(run.path)})`);
  }

  const columns = Number(flags.columns ?? 8);
  const max = Number(flags.max ?? 48);
  const step = Math.max(1, Math.ceil(files.length / max));
  const chosen = files.filter((_, i) => i % step === 0).slice(0, max);
  const cellWidth = Number(flags.size ?? 160);

  const tiles = [];
  for (const file of chosen) {
    tiles.push({ image: await readImage(file, cellWidth), label: numberIn(file) });
  }

  const image = contactSheet(tiles, {
    columns,
    title: `${run.id}  ${chosen.length} of ${files.length} frames, ${step === 1 ? "all of them" : `every ${step}${ordinal(step)}`}`,
    subtitle: `${rel(run.frames)} - labels are each frame's own file number`,
  });

  return {
    image: await writePng(image, outPath(flags, run, "frames")),
    shown: chosen.length,
    total: files.length,
  };
}

async function cmdDepth(positional, flags) {
  const run = resolveRun(positional[0]);
  const { turbo, percentile } = await typed();
  const arrays = await readArrays(run);
  const depth = arrays.depth;
  if (!depth) throw new Error(`run ${run.id} has no depth array`);

  const [count, height, width] = depth.shape;
  const index = clampFrame(flags.frame, count);
  const size = width * height;
  const values = depth.data.subarray(index * size, (index + 1) * size);
  const confidence = flags.confidence && arrays.confidence
    ? arrays.confidence.data.subarray(index * size, (index + 1) * size)
    : null;

  const finite = Float32Array.from(values).filter(Number.isFinite);
  const low = percentile(finite, 2);
  const high = percentile(finite, 98);

  const image = depthImage(values, width, height, {
    turbo,
    low,
    high,
    confidence,
    title: `${run.id}  FRAME ${index} OF ${count}  ${width}X${height}`,
    subtitle: confidence ? "SHADED BY CONFIDENCE" : "DEPTH, METRES",
  });

  const path = await writePng(image, outPath(flags, run, `depth-${String(index).padStart(4, "0")}`));
  const facts = {
    image: path,
    frame: `${index} of ${count}`,
    range: `p2 ${round(low, 3)} m .. p98 ${round(high, 3)} m`,
    holes: `${values.length - finite.length} non-finite of ${values.length}`,
  };
  if (flags.json) return json({ id: run.id, ...facts, low, high });
  out(pairs(facts));
}

/**
 * What of the picture never reached the cloud, and why.
 *
 * DA3's GLB exporter is not a dump of the reconstruction. It applies a confidence floor —
 * `min(max(1.05, p40), p90)` over the WHOLE prediction at once — and then keeps
 * 1,000,000 of the survivors at random. The cap is uniform and harmless; the floor is a
 * single global number applied to frames whose confidence distributions differ wildly, so
 * it does not thin each frame a little, it deletes whichever frames the model was least
 * sure about, entirely. Everything downstream — the ground fit, every height — is measured
 * on what is left.
 *
 * Two masks are drawn, and the difference between them is the point:
 *
 *   PREDICTED — the pixel's confidence is below the reproduced threshold, so DA3's
 *     exporter should have discarded it.
 *   ABSENT — the pixel's own 3D position lands in a voxel holding no cloud point, so it
 *     really is missing, whatever the reason. This one is measured from the GLB and owes
 *     nothing to our model of DA3's arithmetic.
 *
 * Where they agree, the loss is explained. ABSENT without PREDICTED is something else
 * (thin sampling, or a surface no frame saw well). PREDICTED without ABSENT is a pixel
 * another frame rescued, which is why the loss is survivable at all.
 */
async function cmdCoverage(positional, flags) {
  const run = resolveRun(positional[0]);
  const T = await typed();
  const cloud = readCloud(run.glb);
  if (!run.npz) throw new Error(`run ${run.id} has no npz — coverage needs depth and confidence`);

  const arrays = await readArrays(run);
  const { depth, confidence, intrinsics, extrinsics } = arrays;
  if (!depth || !confidence) throw new Error(`run ${run.id} has no confidence array`);
  if (!intrinsics || !extrinsics) throw new Error(`run ${run.id} has no cameras`);

  const [count, height, width] = depth.shape;
  const size = width * height;

  // DA3's own rule, reproduced. Sorted here rather than through `percentile` because that
  // one boxes every value into a JS array, and there are fourteen million of them.
  const sorted = Float32Array.from(confidence.data).sort();
  const p40 = T.percentileOfSorted(sorted, 40);
  const p90 = T.percentileOfSorted(sorted, 90);
  const threshold = Math.min(Math.max(1.05, p40), p90);

  let survivors = 0;
  for (let i = 0; i < confidence.data.length; i++) if (confidence.data[i] >= threshold) survivors += 1;
  const keepRate = survivors > cloud.count ? cloud.count / survivors : 1;

  const perFrame = [];
  for (let f = 0; f < count; f++) {
    let kept = 0;
    for (let i = f * size; i < (f + 1) * size; i++) if (confidence.data[i] >= threshold) kept += 1;
    perFrame.push({ frame: f, survival: kept / size });
  }
  const wiped = perFrame.filter((entry) => entry.survival < 0.02);
  const ranked = [...perFrame].sort((a, b) => a.survival - b.survival);

  // Occupancy, at the resolution a surface is actually resolved to. A cloud holding 12% of
  // the survivors has no point per pixel, so "is this pixel in the cloud" can only be asked
  // of a neighbourhood — hence voxels rather than nearest points.
  const voxel = Number(flags.voxel ?? 0.08);
  const key = (x, y, z) =>
    (Math.floor(x / voxel) + 1_048_576) * 4_398_046_511_104 +
    (Math.floor(y / voxel) + 1_048_576) * 2_097_152 +
    (Math.floor(z / voxel) + 1_048_576);
  const occupied = new Set();
  for (let i = 0; i < cloud.count; i++) {
    occupied.add(key(cloud.points[i * 3], cloud.points[i * 3 + 1], cloud.points[i * 3 + 2]));
  }

  const index = clampFrame(flags.frame, count);
  const frameCloud = T.backprojectFrame({
    depth: depth.data.subarray(index * size, (index + 1) * size),
    confidence: confidence.data.subarray(index * size, (index + 1) * size),
    width,
    height,
    intrinsics: intrinsics.data.subarray(index * 9, index * 9 + 9),
    extrinsics: extrinsics.data.subarray(index * 12, index * 12 + 12),
  });

  const predicted = new Uint8Array(size);
  const absent = new Uint8Array(size);
  let predictedCount = 0;
  let absentCount = 0;
  let both = 0;
  for (let i = 0; i < size; i++) {
    if (!frameCloud.valid[i]) continue;
    const low = confidence.data[index * size + i] < threshold;
    const point = cloud.alignment
      ? apply4x4(cloud.alignment, [
          frameCloud.points[i * 3],
          frameCloud.points[i * 3 + 1],
          frameCloud.points[i * 3 + 2],
        ])
      : [frameCloud.points[i * 3], frameCloud.points[i * 3 + 1], frameCloud.points[i * 3 + 2]];
    const missing = !occupied.has(key(point[0], point[1], point[2]));
    if (low) {
      predicted[i] = 1;
      predictedCount += 1;
    }
    if (missing) {
      absent[i] = 1;
      absentCount += 1;
    }
    if (low && missing) both += 1;
  }

  const files = frameFiles(run.frames);
  let imagePath = null;
  if (files[index]) {
    const photo = await readImage(files[index], Math.max(560, width));
    const image = maskOverlay(
      photo,
      [
        { mask: predicted, rgb: [255, 176, 32], label: "BELOW DA3 CONF FLOOR" },
        { mask: absent, rgb: [255, 64, 200], label: "ABSENT FROM CLOUD" },
      ],
      {
        width,
        height,
        title: `${run.id}  FRAME ${index} OF ${count}  WHAT NEVER REACHED THE CLOUD`,
        // The label font has no semicolon, and an unknown glyph prints as a blob that reads
        // like part of the number beside it.
        subtitle:
          `CONF FLOOR ${round(threshold, 3)} DROPS ${pct(1 - survivors / confidence.data.length)} OF EVERY PIXEL / ` +
          `${pct(keepRate)} OF THE REST KEPT AT RANDOM / VOXEL ${voxel} M`,
      },
    );
    imagePath = await writePng(image, outPath(flags, run, `coverage-${String(index).padStart(4, "0")}`));
  }

  const facts = {
    run: `${run.id} (${run.kind})`,
    pixels: `${confidence.data.length.toLocaleString("en-GB")} in ${count} frames of ${width}x${height}`,
    "conf floor": `${round(threshold, 3)} — DA3's min(max(1.05, p40 ${round(p40, 3)}), p90 ${round(p90, 3)})`,
    survivors: `${survivors.toLocaleString("en-GB")} (${pct(survivors / confidence.data.length)}) — ${pct(1 - survivors / confidence.data.length)} of every pixel is discarded before the cap`,
    cap: `${cloud.count.toLocaleString("en-GB")} in the GLB, so ${pct(keepRate)} of survivors kept at random`,
    "frames wiped": wiped.length
      ? `${wiped.length} below 2% survival: ${wiped.slice(0, 12).map((e) => e.frame).join(", ")}${wiped.length > 12 ? " …" : ""}`
      : "none",
    "worst frames": ranked.slice(0, 5).map((e) => `${e.frame}:${pct(e.survival)}`).join("  "),
    "best frames": ranked.slice(-5).map((e) => `${e.frame}:${pct(e.survival)}`).join("  "),
    frame: `${index}, ${frameCloud.validCount.toLocaleString("en-GB")} pixels with usable depth`,
    predicted: `${pct(predictedCount / frameCloud.validCount)} below the floor`,
    absent: `${pct(absentCount / frameCloud.validCount)} land in an empty ${voxel} m voxel`,
    agreement: absentCount
      ? `${pct(both / absentCount)} of what is absent is explained by the floor; ${pct(both / (predictedCount || 1))} of what the floor drops stays absent`
      : "nothing absent",
    image: imagePath ?? "no source frames on this disk",
  };

  if (flags.json) {
    return json({
      id: run.id,
      threshold,
      p40,
      p90,
      survivors,
      pixels: confidence.data.length,
      cloudCount: cloud.count,
      keepRate,
      voxel,
      frame: index,
      validPixels: frameCloud.validCount,
      predictedCount,
      absentCount,
      both,
      perFrame,
      image: imagePath,
    });
  }
  out(pairs(facts));
}

async function cmdSelect(positional, flags) {
  const run = resolveRun(positional[0]);
  const s = await scene(run, flags, { fitFloor: true });
  const { cloud, T } = s;

  const selection = new Uint8Array(cloud.count);
  let describe;
  let chosen = 0;

  if (flags.band) {
    if (!s.heights) throw new Error(`cannot select by band: no floor fitted (${s.floorError})`);
    const [low, high] = numbers(flags.band, 2, "--band lo,hi");
    for (let i = 0; i < cloud.count; i++) {
      if (s.heights[i] >= low && s.heights[i] <= high) {
        selection[i] = 1;
        chosen += 1;
      }
    }
    describe = `${round(low, 3)}..${round(high, 3)} m above the fitted floor`;
  } else if (flags.near) {
    const centre = numbers(flags.near, 3, "--near x,y,z");
    const radius = Number(flags.radius ?? 0.5);
    const squared = radius * radius;
    for (let i = 0; i < cloud.count; i++) {
      const dx = cloud.points[i * 3] - centre[0];
      const dy = cloud.points[i * 3 + 1] - centre[1];
      const dz = cloud.points[i * 3 + 2] - centre[2];
      if (dx * dx + dy * dy + dz * dz <= squared) {
        selection[i] = 1;
        chosen += 1;
      }
    }
    describe = `within ${radius} m of [${centre.map((v) => round(v, 2)).join(", ")}]`;
  } else {
    throw new Error("select needs --band lo,hi or --near x,y,z --radius m");
  }

  if (chosen === 0) throw new Error(`nothing selected by ${describe}`);

  const facts = {
    run: `${run.id} (${run.kind})`,
    selection: describe,
    selected: `${chosen.toLocaleString("en-GB")} points, ${pct(chosen / cloud.count)} of the cloud`,
  };

  if (s.heights) {
    const picked = new Float64Array(chosen);
    let at = 0;
    for (let i = 0; i < cloud.count; i++) if (selection[i]) picked[at++] = s.heights[i];
    facts.height = `p10 ${round(T.percentile(picked, 10), 3)}  p50 ${round(T.percentile(picked, 50), 3)}  p90 ${round(T.percentile(picked, 90), 3)} m  (nmad ${round(T.nmad(picked), 3)})`;
  }

  const footprint = selectedFootprint(cloud.points, selection, s.up.up, T);
  facts.footprint = `${round(footprint.width, 2)} x ${round(footprint.depth, 2)} m across the ground`;

  const cloudImage = await drawCloud(run, s, flags, {
    view: flags.view ?? "top",
    colour: flags.colour ?? "flat",
    selection,
    suffix: "select",
  });
  facts.cloud = cloudImage;

  // `--out` names one file, and this command draws two. The cloud takes it; the photograph keeps
  // its default name rather than silently overwriting the picture written a moment ago.
  const overlay = await drawFrameOverlay(run, s, { ...flags, out: undefined }, selection, chosen);
  facts.photograph = overlay
    ? `${overlay.path}  (${overlay.hit} marks, ${overlay.occluded} hidden)`
    : frameFiles(run.frames).length === 0
      ? "unavailable: no source frames on this disk for this run"
      : "unavailable: no camera sees any of these points";

  if (flags.json) {
    return json({ id: run.id, selected: chosen, fraction: chosen / cloud.count, images: { cloud: cloudImage, frame: overlay?.path ?? null } });
  }
  out(pairs(facts));
}

/**
 * Everything at once: the run, the cloud, the fit, and four pictures of them.
 *
 * The command to reach for when a measurement is wrong and the stage that broke is not yet known.
 * It costs about four seconds and answers, in order: was the clip right, is the cloud sane, did
 * the floor land where a floor belongs, and does the scene look like the room it came from.
 */
async function cmdExplain(positional, flags) {
  const run = resolveRun(positional[0]);
  const each = { ...flags, json: false, out: undefined };

  out(`=== ${run.id} =======================================================`);
  out("");
  await cmdRun(positional, each);
  out("");
  await cmdCloud(positional, each);
  out("");
  await cmdFloor(positional, each);
  out("");

  const images = [];
  const s = await scene(run, each, { fitFloor: true });

  images.push(await drawCloud(run, s, each, { view: "top", colour: "rgb", suffix: "explain-plan" }));
  if (s.heights) {
    images.push(await drawCloud(run, s, each, { view: "iso", colour: "height", suffix: "explain-height" }));
    images.push(await drawCloud(run, s, each, {
      view: "floor",
      colour: "inlier",
      suffix: "explain-floorband",
    }));
  }
  if (frameFiles(run.frames).length > 0) {
    images.push((await buildContactSheet(run, each)).image);
  }

  out("images");
  for (const path of images) out(`  ${path}`);
  out("");
  out("open these with the Read tool. Numbers alone will not tell you whether the");
  out("floor is under the furniture or through it.");
}

// ── shared machinery ────────────────────────────────────────────────────────────────────────

/**
 * Everything a command needs about a run, loaded once.
 *
 * The ground fit uses the app's own defaults and the app's own gravity path, deliberately: an
 * inspector that fits a floor differently from the interface would report a floor nobody else
 * can see. Where the app REFUSES — incoherent camera up — this reports the refusal and carries
 * on, because being unable to look at a broken run is the opposite of what this is for.
 */
/**
 * The cloud DA3 would have exported if it kept everything: every frame, back-projected
 * from the npz, with no confidence floor.
 *
 * Thinned to roughly the GLB's own point count on purpose. Comparing a four-million-point
 * cloud against a one-million-point one would confound the two things being separated —
 * a floor fit gets better with density regardless of bias. Matched counts leave exactly
 * one difference: WHICH points, not how many.
 *
 * Colour is dropped. It lives in the GLB's vertex colours, and re-reading 99 JPEGs to
 * recover it would buy nothing the height and inlier ramps do not already show.
 */
async function npzCloud(T, arrays, glb, { minConfidence = 0, target = glb.count } = {}) {
  const { depth, confidence, intrinsics, extrinsics } = arrays;
  if (!depth || !intrinsics || !extrinsics) throw new Error("npz has no depth or cameras");

  const [count, height, width] = depth.shape;
  const size = width * height;
  // One step in both directions, so the sample stays a grid rather than a set of stripes.
  const step = Math.max(1, Math.round(Math.sqrt((count * size) / Math.max(1, target))));

  const points = [];
  for (let f = 0; f < count; f++) {
    const frame = T.backprojectFrame({
      depth: depth.data.subarray(f * size, (f + 1) * size),
      confidence: confidence?.data.subarray(f * size, (f + 1) * size),
      width,
      height,
      intrinsics: intrinsics.data.subarray(f * 9, f * 9 + 9),
      extrinsics: extrinsics.data.subarray(f * 12, f * 12 + 12),
    }, { minConfidence });

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = y * width + x;
        if (!frame.valid[i]) continue;
        const raw = [frame.points[i * 3], frame.points[i * 3 + 1], frame.points[i * 3 + 2]];
        const display = glb.alignment ? apply4x4(glb.alignment, raw) : raw;
        points.push(display[0], display[1], display[2]);
      }
    }
  }

  return {
    points: Float32Array.from(points),
    colors: null,
    frusta: glb.frusta,
    count: points.length / 3,
    alignment: glb.alignment,
    origin: `npz, every ${step}${ordinal(step)} pixel, confidence floor ${minConfidence}`,
  };
}

async function scene(run, flags, { fitFloor }) {
  const T = await typed();
  let cloud = readCloud(run.glb);

  let arrays = null;
  let gravity = null;
  let track = null;
  let trackLength = 0;

  // A silent fallback to the GLB here would be the worst possible failure: the command
  // would report the biased cloud under the label of the unbiased one.
  if (!run.npz && flags.cloud === "npz") {
    throw new Error(`run ${run.id} has no npz, so --cloud npz has nothing to build from`);
  }

  if (run.npz) {
    arrays = await readArrays(run);
    if (flags.cloud === "npz") {
      cloud = await npzCloud(T, arrays, cloud, { minConfidence: Number(flags.conf ?? 0) });
    } else if (flags.cloud !== undefined && flags.cloud !== "glb") {
      throw new Error(`--cloud must be glb or npz, not "${flags.cloud}"`);
    }
    if (arrays.extrinsics) {
      const raw = T.estimateGravity(arrays.extrinsics.data);
      gravity = { ...raw, up: transformDirection(raw.up, cloud.alignment, T) };
      const centres = T.cameraCentres(arrays.extrinsics.data);
      const flat = new Float64Array(centres.length * 3);
      centres.forEach((centre, i) => {
        const display = cloud.alignment ? apply4x4(cloud.alignment, centre) : centre;
        flat[i * 3] = display[0];
        flat[i * 3 + 1] = display[1];
        flat[i * 3 + 2] = display[2];
      });
      track = flat;
      for (let i = 0; i < centres.length - 1; i++) {
        trackLength += Math.hypot(
          flat[(i + 1) * 3] - flat[i * 3],
          flat[(i + 1) * 3 + 1] - flat[i * 3 + 1],
          flat[(i + 1) * 3 + 2] - flat[i * 3 + 2],
        );
      }
    }
  }

  let floor = null;
  let floorError = null;
  if (fitFloor) {
    if (!gravity) floorError = "no extrinsics, so no gravity prior";
    else {
      try {
        floor = T.fitGroundPlaneRobust(cloud.points, {
          up: gravity.up,
          maxTiltDeg: Number(flags.tilt ?? 30),
          inlierDistance: Number(flags.inlier ?? 0.035),
          iterations: Number(flags.iterations ?? 1200),
          stride: Number(flags.stride ?? 16),
          minInliers: 100,
          minInlierFraction: 0.01,
          proposalFractions: [1, 0.35],
          supportRatio: 0.1,
          maxBelowFraction: 0.2,
          seed: Number(flags.seed ?? 7),
        });
      } catch (error) {
        floorError = error.message;
      }
    }
  }

  const up = T.resolveUpAxis({
    floorNormal: floor?.plane.normal,
    cameraUp: gravity?.up,
    coherence: gravity?.coherence,
  });

  return {
    T,
    cloud,
    arrays,
    gravity,
    track,
    trackLength,
    floor,
    floorError,
    up,
    heights: floor ? T.heightsAbovePlane(cloud.points, floor.plane) : null,
  };
}

async function drawCloud(run, s, flags, { view, colour, selection = null, suffix = null }) {
  const { T } = s;
  const basis = viewBasis(view, s.up.up, T.basisFromUp, T.normalize, T.cross);
  const size = Number(flags.size ?? 900);
  const [low, high] = flags["height-range"]
    ? numbers(flags["height-range"], 2, "--height-range lo,hi")
    : [0, 2];

  const { image } = renderCloud({
    points: s.cloud.points,
    colors: s.cloud.colors,
    heights: s.heights,
    selection,
    view: basis,
    colour,
    width: size,
    height: size,
    turbo: T.turbo,
    heightRange: [low, high],
    inlierDistance: Number(flags.inlier ?? 0.035),
    cameraTrack: flags.cameras ? s.track : null,
    // A slice from a little below the plane to knee height. Wide enough to show what sits on the
    // ground and what has fallen through it; narrow enough that a 2° tilt is a visible slope.
    floorBand: view === "floor"
      ? (flags["floor-band"] ? numbers(flags["floor-band"], 2, "--floor-band lo,hi") : [-0.3, 0.9])
      : null,
    // Deliberately NOT --stride, which belongs to the ground fit. One flag doing both would let
    // "make this render faster" quietly change the plane the render is drawing.
    stride: Math.max(1, Number(flags.every ?? 1)),
    title: `${run.id}  ${colour.toUpperCase()}  UP FROM ${s.up.source.toUpperCase()}`,
    subtitle: s.floor
      ? `FLOOR ${pct(s.floor.inlierFraction)} SUPPORT, ${round(s.floor.tiltDeg, 1)} DEG TILT, ${pct(s.floor.belowFraction)} BELOW`
      : `NO FLOOR: ${(s.floorError ?? "not fitted").slice(0, 60).toUpperCase()}`,
  });

  return writePng(image, outPath(flags, run, suffix ?? `${view}-${colour}`));
}

/**
 * The selection, drawn on the source photograph that sees most of it.
 *
 * Choosing the frame by how many selected points land in it, rather than taking frame 0, is what
 * makes this useful without an argument: the best view of the thing you selected is the one the
 * camera actually pointed at.
 */
async function drawFrameOverlay(run, s, flags, selection, chosen) {
  const files = frameFiles(run.frames);
  if (files.length === 0 || !s.arrays?.extrinsics || !s.arrays?.intrinsics) return null;
  if (!s.cloud.alignment) return null;

  const inverse = invert4x4(s.cloud.alignment);
  const extrinsics = s.arrays.extrinsics.data;
  const intrinsics = s.arrays.intrinsics.data;
  const frameCount = s.arrays.extrinsics.shape[0];
  const [, height, width] = s.arrays.depth?.shape ?? [frameCount, 0, 0];

  // Selected points in the cameras' own frame, sampled: a hundred thousand marks would paint the
  // whole picture magenta and prove nothing.
  const step = Math.max(1, Math.floor(chosen / 6000));
  const raw = [];
  let seen = 0;
  for (let i = 0; i < s.cloud.count && raw.length < 6000; i++) {
    if (!selection[i]) continue;
    if (seen++ % step !== 0) continue;
    raw.push(apply4x4(inverse, [s.cloud.points[i * 3], s.cloud.points[i * 3 + 1], s.cloud.points[i * 3 + 2]]));
  }

  const depth = s.arrays.depth?.data ?? null;
  const plane = width * height;

  /**
   * Where the selected points land in one frame, MINUS the ones that frame cannot see.
   *
   * Without the occlusion test this overlay lies in the most damaging way available to it:
   * points on the floor behind a desk project onto the desk, and the picture then shows a
   * selection apparently sitting on a surface it never touched. Measured on the door fixture,
   * that put a 0.02–0.45 m band on a table top 0.75 m up. Comparing each point's camera-space
   * distance against the frame's own depth map is what makes the mark mean "visible here".
   */
  const visible = (frame) => {
    const marks = [];
    let occluded = 0;
    for (const point of raw) {
      const pixel = projectToPixel(point, extrinsics, intrinsics, frame);
      if (!pixel) continue;
      const [px, py, z] = pixel;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      if (depth) {
        const surface = depth[frame * plane + Math.round(py) * width + Math.round(px)];
        // Tolerance grows with range because depth noise does. Ahead of the surface is fine:
        // that is the selected point being the nearest thing, which is what we want to see.
        if (Number.isFinite(surface) && z > surface + Math.max(0.03, 0.02 * surface)) {
          occluded += 1;
          continue;
        }
      }
      marks.push([px, py]);
    }
    return { marks, occluded };
  };

  let best = { index: 0, marks: [], occluded: 0 };
  const named = flags.frame !== undefined && flags.frame !== "auto";
  const only = named ? clampFrame(flags.frame, Math.min(frameCount, files.length)) : null;

  for (let frame = 0; frame < Math.min(frameCount, files.length); frame++) {
    if (named && frame !== only) continue;
    const found = visible(frame);
    if (found.marks.length > best.marks.length || named) best = { index: frame, ...found };
  }

  const { index, marks, occluded } = best;
  if (marks.length === 0) return null;

  // Drawn at least 560 px wide whatever the reconstruction resolution was: at the model's own
  // 280 px a frame is too small to tell grass from gravel, which is the entire question here.
  const photo = await readImage(files[index], Math.max(560, width));
  const scaleX = photo.width / width;
  const scaleY = photo.height / height;
  const image = frameOverlay(photo, marks.map(([x, y]) => [x * scaleX, y * scaleY]), {
    title: `${run.id}  FRAME ${index}  SELECTION ON THE SOURCE FRAME`,
    subtitle: `SAMPLED 1 IN ${step}, ${occluded} HIDDEN BEHIND SOMETHING`,
    hit: marks.length,
    total: raw.length,
  });

  const path = await writePng(image, outPath(flags, run, `select-frame-${String(index).padStart(4, "0")}`));
  return { path, index, hit: marks.length, occluded };
}

function transformDirection(direction, alignment, T) {
  if (!alignment) return direction;
  const value = T.normalize([
    alignment[0] * direction[0] + alignment[1] * direction[1] + alignment[2] * direction[2],
    alignment[4] * direction[0] + alignment[5] * direction[1] + alignment[6] * direction[2],
    alignment[8] * direction[0] + alignment[9] * direction[1] + alignment[10] * direction[2],
  ]);
  if (!value) throw new Error("the GLB's alignment has a degenerate rotation");
  return value;
}

function cloudStats(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0];
  let finite = 0;
  let nonFinite = 0;

  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      nonFinite += 1;
      continue;
    }
    finite += 1;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
    sum[0] += x;
    sum[1] += y;
    sum[2] += z;
  }

  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    min,
    max,
    size,
    diagonal: Math.hypot(...size),
    centroid: sum.map((v) => v / Math.max(1, finite)),
    finite,
    nonFinite,
  };
}

function quantilesAlong(points, up, T) {
  const stride = Math.max(1, Math.floor(points.length / 3 / 200_000));
  const values = [];
  for (let i = 0; i < points.length / 3; i += stride) {
    const value = points[i * 3] * up[0] + points[i * 3 + 1] * up[1] + points[i * 3 + 2] * up[2];
    if (Number.isFinite(value)) values.push(value);
  }
  const array = Float64Array.from(values);
  return { p1: T.percentile(array, 1), p50: T.percentile(array, 50), p99: T.percentile(array, 99) };
}

function selectedFootprint(points, selection, up, T) {
  const { e1, e2 } = T.basisFromUp(up);
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (let i = 0; i < selection.length; i++) {
    if (!selection[i]) continue;
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    const a = x * e1[0] + y * e1[1] + z * e1[2];
    const b = x * e2[0] + y * e2[1] + z * e2[2];
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  return { width: maxA - minA, depth: maxB - minB };
}

/**
 * How far ahead the winning hypothesis is.
 *
 * A narrow margin means the automatic floor choice was close to going the other way, which is
 * the thing nothing in this project currently reports. `fitGroundPlaneRobust` already returns
 * every hypothesis it considered; this only does the subtraction.
 *
 * `separation` normalises the gap by the two scores' combined size rather than by the winner's,
 * because `groundPlaneQuality` is a penalty and its scores are usually NEGATIVE — "43% of the
 * winner" would then be arithmetic with no meaning. As defined here 0 is a dead heat and 1 is
 * no contest, whatever sign the scores carry.
 */
function marginOf(ranked) {
  if (ranked.length < 2) return null;
  const best = ranked[0].qualityScore;
  const next = ranked[1].qualityScore;
  const gap = best - next;
  return {
    gap,
    separation: gap / Math.max(1e-9, Math.abs(best) + Math.abs(next)),
    winnerQuality: best,
    runnerUpQuality: next,
    runnerUpProposal: ranked[1].proposalFraction,
  };
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i += 1;
    }
  }
  return { command: positional.shift(), positional, flags };
}

function outPath(flags, run, suffix) {
  if (typeof flags.out === "string") return resolve(flags.out);
  return resolve(OUT_ROOT, `${run.id}-${suffix}.png`);
}

function numbers(value, expected, usage) {
  const parts = String(value).split(",").map(Number);
  if (parts.length !== expected || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`bad value "${value}" — expected ${usage}`);
  }
  return parts;
}

function clampFrame(value, count) {
  if (value === undefined || value === "auto") return Math.floor(count / 2);
  const index = Number(value);
  if (!Number.isFinite(index)) throw new Error(`--frame must be a number or "auto"`);
  return Math.min(count - 1, Math.max(0, Math.round(index)));
}

function numberIn(path) {
  return basename(path).match(/(\d+)/)?.[1] ?? basename(path);
}

function ordinal(n) {
  return n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
}

function pairs(object) {
  const width = Math.max(...Object.keys(object).map((key) => key.length));
  return Object.entries(object)
    .map(([key, value]) => `${key.padEnd(width)}  ${value}`)
    .join("\n");
}

function table(headers, rows) {
  const all = [headers, ...rows.map((row) => row.map(String))];
  const widths = headers.map((_, i) => Math.max(...all.map((row) => String(row[i] ?? "").length)));
  return all
    .map((row) => row.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}

function strip(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === "hypotheses" ? undefined : v)));
}

const rel = (path) => (path && path.startsWith(REPO) ? relative(REPO, path) : path);
const round = (value, digits) => (Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : "?");
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const fmtVec = (v) => `[${v.map((n) => Number(n).toFixed(3)).join(", ")}]`;
const out = (line) => process.stdout.write(`${line}\n`);
const json = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

// Last, so every helper above is initialised before a command can reach for one.
await main();
