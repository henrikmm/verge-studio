/**
 * Building the point cloud we measure, from the depth maps rather than from DA3's export.
 *
 * DA3's GLB exporter picks its confidence floor from percentiles taken over the WHOLE
 * prediction at once, then keeps a random million of whatever survives. Confidence only ranks
 * pixels WITHIN one image — it has no fixed meaning between images — so a pooled threshold
 * compares numbers that are not comparable. It does not thin each frame a little; it deletes
 * whichever frames the model was least sure about, entirely. Measured on the outdoor run: five
 * frames contribute under 2% of their pixels while the camera keeps walking for metres.
 *
 * Everything here follows from that one observation:
 *
 *   THRESHOLD PER FRAME. Each frame gets its own floor, from its own distribution. Same
 *     formula DA3 uses, applied where the numbers are comparable.
 *   WEIGHT BY RANK, NOT BY VALUE. A point's weight is its confidence's percentile rank inside
 *     its own frame. Raw confidence is unbounded (`exp(x)+1`; measured 1.00–25.09 across our
 *     runs), so using it directly would let one frame's scale out-vote another's — the same
 *     mistake one level down.
 *   VOXEL, NOT STRIDE. Pixel sampling is uniform in PIXELS, so a surface the camera stood
 *     close to or dwelt on gets more votes. The ground fit draws random triples, so that bias
 *     goes straight into which plane wins. A voxel grid is uniform in SPACE instead.
 *
 * Metric scale survives all of it. DA3 fixes the scale once per clip and applies the same
 * scalar to depth and to the camera translations together, so back-projection is linear in
 * depth with no scale term anywhere. Nothing here may normalise, re-centre or rescale a
 * position — confidence selects and weights, and never multiplies into a coordinate.
 */

import { backprojectFrame, type Frame } from "./backproject";

/** How each frame's confidence floor is chosen. */
export type ConfidenceRule =
  /** Keep every pixel with usable depth. */
  | { kind: "none" }
  /**
   * DA3's own formula, `min(max(1.05, p40), p90)`, taken per frame instead of pooled.
   * The 1.05 base never binds in practice, so this reads as "drop each frame's least
   * confident 40%".
   */
  | { kind: "da3-per-frame" }
  /** Drop each frame's least confident `drop` percent. */
  | { kind: "percentile"; drop: number }
  /** One fixed floor for every frame. Only honest when comparing against DA3's own export. */
  | { kind: "absolute"; minConfidence: number };

/** How a surviving point's confidence becomes a plane-fit weight. */
export type WeightRule =
  /** Every point counts 1. */
  | "none"
  /** Confidence's percentile rank inside its own frame, in [0,1]. */
  | "rank"
  /** Raw confidence. Comparable within a frame, not across frames — measured, not recommended. */
  | "linear";

export interface BuildCloudOptions {
  confidence?: ConfidenceRule;
  weight?: WeightRule;
  /** Voxel edge in metres. 0 disables downsampling. */
  voxelM?: number;
  /** Keep every Nth pixel in both directions, before voxelling. 1 keeps all of them. */
  pixelStride?: number;
  /**
   * Cap the cloud at this many points, chosen uniformly at random.
   *
   * A budget, and the only honest way to compare against DA3's export — that cloud is
   * capped at exactly 1,000,000, and a fit scored on 9.5 million points is not the same
   * measurement however good the points are. Uniform, so it cannot remove a region.
   */
  maxPoints?: number;
  /** Seed for the cap's selection. Fixed by default, because the fit caches on content. */
  seed?: number;
  /**
   * How a finite cap is chosen.
   *
   * `legacy` preserves every measurement already graded in this project. `reservoir` bounds
   * memory by the cap and is for display clouds, whose point order is not scientific evidence.
   */
  sampling?: "legacy" | "reservoir";
  /** Ignore depths outside this range, in metres. */
  minDepthM?: number;
  maxDepthM?: number;
  /**
   * Drop a pixel whose depth differs from a 4-neighbour by more than this fraction of its own
   * depth. 0 disables.
   *
   * Not optional in practice, and the measurement says why. DA3's pooled confidence floor was
   * removing flying pixels as a side effect — silhouette pixels blend foreground and
   * background depth, and the model is least confident exactly there. Replace that floor with
   * a per-frame one and the coverage is fixed but the flying pixels come back, dragging the
   * graded tabletop 4 mm low against a gate whose own noise is 1.5 mm. An edge filter we chose
   * is better than one we inherited by accident.
   */
  maxRelativeDepthStep?: number;
  /** Row-major 4×4 applied to every point — DA3's `hf_alignment`. Identity when absent. */
  transform?: ArrayLike<number>;
  /** Do not allocate colour buffers for a measurement-only cloud. */
  includeColors?: boolean;
  /** Stop an obsolete browser build at the next frame or row boundary. */
  signal?: AbortSignal;
}

/** What one frame put into the cloud, and what it did not. */
export interface FrameContribution {
  frame: number;
  /** The confidence floor used for this frame. 0 when no rule applied. */
  threshold: number;
  /** Pixels in the frame. */
  pixels: number;
  /** Pixels with finite depth inside the depth range, before any quality filter. */
  usable: number;
  /** Pixels dropped for sitting on a depth edge. */
  edges: number;
  /** Pixels that survived every filter and reached the cloud, before voxelling. */
  kept: number;
}

export interface BuiltCloud {
  /** Flat xyz, in the frame `transform` maps into. */
  positions: Float32Array;
  /**
   * Per-point plane-fit weight, normalised so the mean is 1.
   *
   * Mean 1 on purpose: `fitGroundPlaneRobust` reports `inlierFraction` as
   * `inlierWeight / totalWeight`, so a weight set averaging 1 keeps that number on the same
   * scale as the unweighted fit it replaces. Every support percentage on record stays
   * comparable. All-ones reduces exactly to the old behaviour.
   */
  weights: Float32Array;
  /** Per-point raw DA3 confidence, carried rather than discarded at the door. */
  confidence: Float32Array;
  /**
   * Per-point RGB, three bytes each, or null when no frame carried an image.
   *
   * The real colour of the scene, sampled from the source photographs. A height ramp is a
   * reading of one coordinate; this is what the camera saw, and it is what makes a cloud
   * recognisable as a place rather than a shape.
   */
  colors: Uint8Array | null;
  pointCount: number;
  frames: FrameContribution[];
  /** Voxel edge actually used, in metres. 0 when downsampling was off. */
  voxelM: number;
  /** Points before voxelling. Equals `pointCount` when downsampling was off. */
  pointsBeforeVoxel: number;
  /**
   * Largest loose point buffer allocated by this build.
   *
   * With a finite cap this never exceeds the cap. Kept as a diagnostic because the old builder
   * allocated all 13.8 million outdoor points before copying the chosen 1M–6M.
   */
  allocatedPoints: number;
  /** One line saying where these points came from, for the inspector to print. */
  origin: string;
}

const HISTOGRAM_BINS = 4096;

/** Half the addressable voxel span per axis, in cells. See `VoxelGrid.add`. */
const VOXEL_HALF_SPAN = 65536;

/**
 * A frame's confidence distribution, as a histogram.
 *
 * A sort would cost 112 sorts of 141,120 floats per run — measured at 1.0 s on the door
 * fixture, against 213 ms for the whole back-projection. The histogram answers both questions
 * this file asks (a percentile, and every point's rank) in one pass over the frame.
 */
class ConfidenceHistogram {
  private readonly counts = new Int32Array(HISTOGRAM_BINS);
  private readonly cumulative = new Float64Array(HISTOGRAM_BINS);
  private readonly min: number;
  private readonly span: number;
  private total = 0;

  constructor(confidence: ArrayLike<number>, usable: Uint8Array) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < usable.length; i++) {
      if (!usable[i]) continue;
      const value = confidence[i];
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    this.min = Number.isFinite(min) ? min : 0;
    this.span = Number.isFinite(max) && max > this.min ? max - this.min : 1;

    for (let i = 0; i < usable.length; i++) {
      if (!usable[i]) continue;
      const value = confidence[i];
      if (!Number.isFinite(value)) continue;
      this.counts[this.bin(value)] += 1;
      this.total += 1;
    }
    let running = 0;
    for (let b = 0; b < HISTOGRAM_BINS; b++) {
      running += this.counts[b];
      this.cumulative[b] = running;
    }
  }

  private bin(value: number): number {
    const t = (value - this.min) / this.span;
    return Math.max(0, Math.min(HISTOGRAM_BINS - 1, Math.floor(t * (HISTOGRAM_BINS - 1))));
  }

  /**
   * The confidence value at percentile `p` (0–100). Returns 0 for an empty frame.
   *
   * Nearest-rank, where numpy's `percentile` interpolates between the two neighbouring
   * samples. On a real frame — 141,120 pixels with ~140,000 distinct confidences — the two
   * agree to well under one bin, measured on the door fixture. They diverge only on
   * distributions with heavy ties, which a confidence map does not have.
   */
  percentile(p: number): number {
    if (this.total === 0) return 0;
    const wanted = (Math.max(0, Math.min(100, p)) / 100) * this.total;
    for (let b = 0; b < HISTOGRAM_BINS; b++) {
      if (this.cumulative[b] >= wanted) {
        return this.min + (b / (HISTOGRAM_BINS - 1)) * this.span;
      }
    }
    return this.min + this.span;
  }

  /** Where `value` sits in this frame's distribution, in [0,1]. */
  rank(value: number): number {
    if (this.total === 0) return 1;
    return this.cumulative[this.bin(value)] / this.total;
  }
}

function thresholdFor(rule: ConfidenceRule, histogram: ConfidenceHistogram): number {
  switch (rule.kind) {
    case "none":
      return 0;
    case "absolute":
      return rule.minConfidence;
    case "percentile":
      return histogram.percentile(rule.drop);
    case "da3-per-frame":
      // DA3's own rule, from `export_to_glb`. Kept verbatim so the only thing that changed
      // between their cloud and ours is WHERE the percentiles are taken.
      return Math.min(Math.max(1.05, histogram.percentile(40)), histogram.percentile(90));
  }
}

function applyTransform(
  transform: ArrayLike<number> | undefined,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  if (!transform) return [x, y, z];
  const m = transform;
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

/**
 * A voxel grid that keeps one confidence-weighted centroid per cell.
 *
 * Keyed on a packed integer rather than a string: a string key per point allocates once per
 * point, and there are 15.8 million of them on a 112-frame run.
 */
class VoxelGrid {
  private readonly slots = new Map<number, number>();
  private readonly sx: number[] = [];
  private readonly sy: number[] = [];
  private readonly sz: number[] = [];
  private readonly sw: number[] = [];
  private readonly sc: number[] = [];
  private readonly sr: number[] = [];
  private readonly sg: number[] = [];
  private readonly sb: number[] = [];
  private readonly n: number[] = [];
  /** Points too far from the origin to index without two cells colliding. */
  outOfRange = 0;

  constructor(private readonly edge: number) {}

  /** False when the point fell outside the addressable grid and was not stored. */
  add(
    x: number,
    y: number,
    z: number,
    weight: number,
    confidence: number,
    r: number,
    g: number,
    b: number,
  ): boolean {
    const ix = Math.floor(x / this.edge);
    const iy = Math.floor(y / this.edge);
    const iz = Math.floor(z / this.edge);
    // 17 bits per axis, biased to stay non-negative, so the packed key stays under 2^51 and
    // inside the range a double indexes exactly. At 2 cm that addresses ±1.3 km per axis.
    // Collisions here would silently merge two distant surfaces, so out-of-range is refused
    // rather than clamped.
    if (
      ix < -VOXEL_HALF_SPAN || ix >= VOXEL_HALF_SPAN ||
      iy < -VOXEL_HALF_SPAN || iy >= VOXEL_HALF_SPAN ||
      iz < -VOXEL_HALF_SPAN || iz >= VOXEL_HALF_SPAN
    ) {
      this.outOfRange += 1;
      return false;
    }
    const key =
      (ix + VOXEL_HALF_SPAN) * 17179869184 +
      (iy + VOXEL_HALF_SPAN) * 131072 +
      (iz + VOXEL_HALF_SPAN);
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = this.sx.length;
      this.slots.set(key, slot);
      this.sx.push(0);
      this.sy.push(0);
      this.sz.push(0);
      this.sw.push(0);
      this.sc.push(0);
      this.sr.push(0);
      this.sg.push(0);
      this.sb.push(0);
      this.n.push(0);
    }
    // Weighted centroid: a confident pixel pulls the representative point towards itself.
    const w = weight > 0 ? weight : 1e-6;
    this.sx[slot] += x * w;
    this.sy[slot] += y * w;
    this.sz[slot] += z * w;
    this.sw[slot] += w;
    this.sc[slot] += confidence;
    this.sr[slot] += r;
    this.sg[slot] += g;
    this.sb[slot] += b;
    this.n[slot] += 1;
    return true;
  }

  get size(): number {
    return this.sx.length;
  }

  /** Cell centroids, their mean weight, mean confidence and mean colour. */
  drain(): CloudBuffers {
    const count = this.sx.length;
    const positions = new Float32Array(count * 3);
    const weights = new Float32Array(count);
    const confidence = new Float32Array(count);
    const colors = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      const w = this.sw[i];
      const n = this.n[i];
      positions[i * 3] = this.sx[i] / w;
      positions[i * 3 + 1] = this.sy[i] / w;
      positions[i * 3 + 2] = this.sz[i] / w;
      weights[i] = w / n;
      confidence[i] = this.sc[i] / n;
      colors[i * 3] = this.sr[i] / n;
      colors[i * 3 + 1] = this.sg[i] / n;
      colors[i * 3 + 2] = this.sb[i] / n;
    }
    return { positions, weights, confidence, colors };
  }
}

/**
 * A seeded generator, so a cap chosen "at random" is the same cap every run.
 *
 * Deliberately its own copy rather than shared with `plane.ts`. That one's stream is baked
 * into every ground fit on record, and touching it would move numbers this project has
 * measured and written down.
 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("cloud build aborted");
}

interface CloudBuffers {
  positions: Float32Array;
  weights: Float32Array;
  confidence: Float32Array;
  colors: Uint8Array;
}

/** Uniform selection without replacement — a partial Fisher–Yates over the point indices. */
function capPoints(built: CloudBuffers, keep: number, seed: number): CloudBuffers {
  const total = built.weights.length;
  if (keep >= total) return built;
  const index = new Int32Array(total);
  for (let i = 0; i < total; i++) index[i] = i;
  const random = makeRandom(seed);
  for (let i = 0; i < keep; i++) {
    const j = i + Math.floor(random() * (total - i));
    const swap = index[i];
    index[i] = index[j];
    index[j] = swap;
  }
  const positions = new Float32Array(keep * 3);
  const weights = new Float32Array(keep);
  const confidence = new Float32Array(keep);
  const colors = new Uint8Array(built.colors.length > 0 ? keep * 3 : 0);
  for (let i = 0; i < keep; i++) {
    const source = index[i];
    positions[i * 3] = built.positions[source * 3];
    positions[i * 3 + 1] = built.positions[source * 3 + 1];
    positions[i * 3 + 2] = built.positions[source * 3 + 2];
    if (colors.length > 0) {
      colors[i * 3] = built.colors[source * 3];
      colors[i * 3 + 1] = built.colors[source * 3 + 1];
      colors[i * 3 + 2] = built.colors[source * 3 + 2];
    }
    weights[i] = built.weights[source];
    confidence[i] = built.confidence[source];
  }
  return { positions, weights, confidence, colors };
}

function describe(options: Required<Pick<BuildCloudOptions, "confidence" | "weight">> & {
  voxelM: number;
  pixelStride: number;
  maxPoints: number;
}): string {
  const rule =
    options.confidence.kind === "none"
      ? "every pixel"
      : options.confidence.kind === "da3-per-frame"
        ? "DA3's floor per frame"
        : options.confidence.kind === "percentile"
          ? `lowest ${options.confidence.drop}% dropped per frame`
          : `confidence floor ${options.confidence.minConfidence}`;
  const parts = [`npz, ${rule}`];
  if (options.pixelStride > 1) parts.push(`every ${options.pixelStride}th pixel`);
  if (options.voxelM > 0) parts.push(`${(options.voxelM * 100).toFixed(1)} cm voxels`);
  if (Number.isFinite(options.maxPoints)) {
    parts.push(`capped at ${options.maxPoints.toLocaleString("en-GB")}`);
  }
  if (options.weight !== "none") parts.push(`${options.weight} weights`);
  return parts.join(", ");
}

/**
 * Build a cloud from every frame of a run.
 *
 * `frames` are views into the npz rather than copies, so this holds one frame's worth of
 * back-projected points at a time and never materialises the full-resolution cloud twice.
 */
export function buildCloud(frames: readonly Frame[], options: BuildCloudOptions = {}): BuiltCloud {
  const confidenceRule = options.confidence ?? { kind: "da3-per-frame" };
  // Unweighted by default. Rank weighting is implemented and tested, and measured 2026-08-08
  // on the door fixture it moved the fitted floor's tilt by 0.05° and the graded tabletop by
  // 0.9 mm — in the wrong direction, though within the gate's own 1.5 mm noise. There is no
  // ground truth for a floor, so "different" is all that measurement can say. Defaulting to
  // something with no evidence behind it is how an unexamined choice becomes a baseline.
  const weightRule = options.weight ?? "none";
  const voxelM = Math.max(0, options.voxelM ?? 0);
  const pixelStride = Math.max(1, Math.floor(options.pixelStride ?? 1));
  const minDepthM = options.minDepthM ?? 1e-4;
  const maxDepthM = options.maxDepthM ?? Infinity;
  const maxRelativeDepthStep = options.maxRelativeDepthStep ?? 0.08;
  const maxPoints = options.maxPoints ?? Infinity;
  const includeColors = options.includeColors ?? true;
  const sampling = options.sampling ?? "legacy";
  // A partly coloured cloud used to encode every point from a missing photograph as RGB 0,0,0.
  // That looked exactly like missing geometry. Photo colour is therefore all-or-nothing.
  const allFramesColoured =
    includeColors &&
    frames.length > 0 &&
    frames.every((frame) => frame.rgb?.length === frame.width * frame.height * 3);

  const contributions: FrameContribution[] = [];
  const grid = voxelM > 0 ? new VoxelGrid(voxelM) : null;

  // A finite point budget is also the allocation bound. Reservoir sampling chooses uniformly
  // while points stream past, so the 6M display never first materialises all 13.8M candidates.
  let upperBound = 0;
  if (!grid) {
    for (const frame of frames) {
      upperBound +=
        Math.ceil(frame.height / pixelStride) * Math.ceil(frame.width / pixelStride);
    }
  }
  const finiteCap = Number.isFinite(maxPoints)
    ? Math.max(0, Math.floor(maxPoints))
    : upperBound;
  const capacity = grid
    ? 0
    : sampling === "reservoir"
      ? Math.min(upperBound, finiteCap)
      : upperBound;
  const loosePositions = new Float32Array(capacity * 3);
  const looseWeights = new Float32Array(capacity);
  const looseConfidence = new Float32Array(capacity);
  const looseColors = new Uint8Array(allFramesColoured ? capacity * 3 : 0);
  const random = makeRandom(options.seed ?? 7);
  let written = 0;
  let before = 0;

  for (let f = 0; f < frames.length; f++) {
    assertNotAborted(options.signal);
    const frame = frames[f];
    const { width, height, confidence, rgb } = frame;
    const pixels = width * height;

    // One back-projection with no confidence floor, so `usable` counts what the depth map
    // could have given us and the confidence rule's cost is reported separately.
    const cloud = backprojectFrame(frame, {
      minDepth: minDepthM,
      maxDepth: maxDepthM,
      maxRelativeDepthStep,
    });

    let threshold = 0;
    let histogram: ConfidenceHistogram | null = null;
    if (confidence && confidenceRule.kind !== "none") {
      histogram = new ConfidenceHistogram(confidence, cloud.valid);
      threshold = thresholdFor(confidenceRule, histogram);
    } else if (confidence && weightRule === "rank") {
      histogram = new ConfidenceHistogram(confidence, cloud.valid);
    }

    let kept = 0;
    for (let y = 0; y < height; y += pixelStride) {
      if ((y & 15) === 0) assertNotAborted(options.signal);
      for (let x = 0; x < width; x += pixelStride) {
        const index = y * width + x;
        if (!cloud.valid[index]) continue;
        const raw = confidence ? confidence[index] : 0;
        if (confidence && raw < threshold) continue;
        kept += 1;

        let weight = 1;
        if (confidence && weightRule === "rank" && histogram) weight = histogram.rank(raw);
        else if (confidence && weightRule === "linear") weight = raw;

        const [px, py, pz] = applyTransform(
          options.transform,
          cloud.points[index * 3],
          cloud.points[index * 3 + 1],
          cloud.points[index * 3 + 2],
        );
        before += 1;
        const r = allFramesColoured && rgb ? rgb[index * 3] : 0;
        const g = allFramesColoured && rgb ? rgb[index * 3 + 1] : 0;
        const b = allFramesColoured && rgb ? rgb[index * 3 + 2] : 0;
        if (grid) {
          grid.add(px, py, pz, weight, raw, r, g, b);
        } else {
          let slot: number;
          if (written < capacity) {
            slot = written;
            written += 1;
          } else if (sampling === "reservoir") {
            // Standard reservoir sampling: the nth candidate replaces one of the first `cap`
            // with probability cap/n. The final set is uniform without a full-size index array.
            const replacement = Math.floor(random() * before);
            if (replacement >= capacity) continue;
            slot = replacement;
          } else {
            // `capacity` is the exact pixel upper bound in legacy mode, so this is unreachable.
            throw new Error("cloud buffer capacity was underestimated");
          }
          loosePositions[slot * 3] = px;
          loosePositions[slot * 3 + 1] = py;
          loosePositions[slot * 3 + 2] = pz;
          if (allFramesColoured) {
            looseColors[slot * 3] = r;
            looseColors[slot * 3 + 1] = g;
            looseColors[slot * 3 + 2] = b;
          }
          looseWeights[slot] = weight;
          looseConfidence[slot] = raw;
        }
      }
    }

    contributions.push({
      frame: f,
      threshold,
      pixels,
      usable: cloud.validCount + cloud.edgeRejected,
      edges: cloud.edgeRejected,
      kept,
    });
  }

  const built: CloudBuffers = grid
    ? grid.drain()
    : {
        positions: loosePositions.subarray(0, written * 3),
        weights: looseWeights.subarray(0, written),
        confidence: looseConfidence.subarray(0, written),
        colors: looseColors.subarray(0, written * 3),
      };
  const drained =
    maxPoints < built.weights.length
      ? capPoints(built, Math.floor(maxPoints), options.seed ?? 7)
      : built;

  // Mean 1, so `inlierFraction` stays on the scale every recorded support figure used.
  const weights = drained.weights;
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  const mean = weights.length > 0 ? total / weights.length : 0;
  if (mean > 0) for (let i = 0; i < weights.length; i++) weights[i] /= mean;

  return {
    positions: drained.positions,
    weights,
    confidence: drained.confidence,
    // Null rather than a black buffer when no frame carried an image: a caller must be able to
    // tell "the scene is dark here" from "nobody told me the colour".
    colors: allFramesColoured ? drained.colors : null,
    pointCount: drained.positions.length / 3,
    frames: contributions,
    voxelM,
    pointsBeforeVoxel: before,
    allocatedPoints: grid ? grid.size : capacity,
    origin: describe({
      confidence: confidenceRule,
      weight: weightRule,
      voxelM,
      pixelStride,
      maxPoints,
    }),
  };
}

/** One array out of a run's npz. Structural, so `geometry/` need not import the app's reader. */
export interface NpzArray {
  shape: readonly number[];
  data: Float32Array;
}

/**
 * Slice a run's npz arrays into per-frame views.
 *
 * Views, not copies: the npz for a 112-frame run holds 121 MB of depth and confidence, and
 * copying it per frame is the difference between 213 ms and a memory spike.
 *
 * Takes the whole record rather than named arguments because that is what the npz reader
 * returns, and checks the keys here — a missing `extrinsics` is a run that cannot be placed
 * in the world at all, which deserves a sentence rather than an undefined.
 */
export function framesFromArrays(arrays: Record<string, NpzArray | undefined>): Frame[] {
  const { depth, confidence, intrinsics, extrinsics } = arrays;
  if (!depth || !intrinsics || !extrinsics) {
    const missing = ["depth", "intrinsics", "extrinsics"].filter((key) => !arrays[key]);
    throw new Error(`npz has no ${missing.join(", ")} — nothing to back-project`);
  }
  if (depth.shape.length !== 3) {
    throw new Error(`npz depth has shape [${depth.shape}], expected [frames, height, width]`);
  }
  const [count, height, width] = depth.shape;
  const size = width * height;
  const frames: Frame[] = [];
  for (let f = 0; f < count; f++) {
    frames.push({
      depth: depth.data.subarray(f * size, (f + 1) * size),
      confidence: confidence?.data.subarray(f * size, (f + 1) * size),
      width,
      height,
      intrinsics: intrinsics.data.subarray(f * 9, f * 9 + 9),
      extrinsics: extrinsics.data.subarray(f * 12, f * 12 + 12),
    });
  }
  return frames;
}
