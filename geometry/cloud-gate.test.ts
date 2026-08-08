/**
 * The gate for the point-cloud rebuild: the tabletop nobody painted, over a floor nobody refit.
 *
 * Every graded measurement this project has is a vertical extent — p98 minus p2 of
 * `dot(normal, p) + offset` — so the plane's offset cancels and the number reads the fitted
 * NORMAL and nothing else. Measured 2026-08-08: the door height moves 0.3 mm across four clouds
 * differing by 400,000 points. It cannot see a cloud change, so it cannot gate one.
 *
 * `horizontalLevels` can. It finds flat surfaces from the cloud alone, with no mask and no
 * operator, and it reads a surface's ABSOLUTE height above the floor.
 *
 * THE FLOOR IS HELD FIXED, and that is the whole design. Grading against each cloud's OWN
 * refitted floor conflates two different questions — did the cloud change, and did the fit
 * land somewhere else — and measured 2026-08-08 it answers the wrong one: the tabletop appeared
 * to degrade by 2–4 mm across the rebuilt clouds, and every millimetre of it was the plane
 * moving. Against one fixed plane the same five clouds read 699.4, 699.2, 699.5, 699.4 and
 * 699.3 mm. The geometry does not move; the fit does. So the fit is reported here as evidence
 * and gated separately, and this number answers only "is the cloud's geometry still right".
 *
 * Graded against the tape truth in `MEASUREMENTS.md` (clip B): the tabletop is 0.750 m above
 * the floor.
 *
 * The tower is deliberately NOT gated. Its peak carries 2.9% of the cloud at 2.0× prominence
 * on DA3's own export — marginal enough that a denser cloud raises the background around it
 * and `horizontalLevels` stops reporting it at all. A gate that silently stops measuring is
 * worse than no gate.
 *
 * The fixture payloads are gitignored, so these SKIP on a fresh clone. A test that fails
 * without a 16 MB GLB would train everyone to ignore red.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNpz } from "../app/src/lib/npz";
import { buildCloud, framesFromArrays } from "./cloud";
import { readGlbCloud, transformDirection } from "./fixture-support";
import { estimateGravity } from "./gravity";
import { horizontalLevels, levelNear } from "./levels";
import { fitGroundPlaneRobust } from "./plane";
import type { Plane } from "./types";

const ROOT = new URL("../fixtures/door/504px-112f/", import.meta.url);
const NPZ = fileURLToPath(new URL("verge-result.npz", ROOT));
const GLB = fileURLToPath(new URL("scene.glb", ROOT));
const available = existsSync(NPZ) && existsSync(GLB);

/** Tape truth for clip B, from `MEASUREMENTS.md`. */
const TABLETOP_TRUTH_M = 0.75;

/**
 * What DA3's own cloud reads over its own fitted floor, measured 2026-08-08.
 *
 * The reference every rebuilt cloud is graded against. Pinned in a test rather than only in
 * prose because a gate nobody runs is a note.
 */
const GLB_BASELINE_M = 0.6994;

/**
 * How far a rebuilt cloud's tabletop may sit from DA3's, over the same floor.
 *
 * 1.5 mm is the gate's own noise: measured 2026-08-08, varying only the RANSAC seed moves the
 * graded tabletop by 0.1–1.7 mm and varying only which million points survive the cap moves it
 * by 0.7–1.7 mm. A bound below that would fail on nothing but the seed.
 */
const TOLERANCE_M = 0.0015;

/** The app's own ground-fit settings, so the gate and the interface cannot disagree. */
const FIT = {
  maxTiltDeg: 30,
  inlierDistance: 0.035,
  iterations: 1200,
  stride: 16,
  minInliers: 100,
  minInlierFraction: 0.01,
  proposalFractions: [1, 0.35],
  maxBelowFraction: 0.2,
  seed: 7,
} as const;

export interface MasklessGrade {
  tabletopM: number;
  tabletopErrorM: number;
  tabletopPoints: number;
  /** Robust spread of the surface's point heights. Reads the floor's orientation error. */
  thicknessM: number;
}

/**
 * Grade the door clip's tabletop against a plane the caller supplies.
 *
 * Throws rather than returning null: a gate that quietly reports nothing measured is a pass
 * it did not earn.
 */
export function gradeTabletop(points: Float32Array, plane: Plane): MasklessGrade {
  const levels = horizontalLevels(points, plane, { stride: 16 });
  const tabletop = levelNear(levels, TABLETOP_TRUTH_M, 0.25);
  if (!tabletop) throw new Error("no surface within 0.25 m of the 0.75 m tabletop");
  return {
    tabletopM: tabletop.height,
    tabletopErrorM: tabletop.height - TABLETOP_TRUTH_M,
    tabletopPoints: tabletop.count,
    thicknessM: tabletop.thickness,
  };
}

/** Fit the floor of a cloud already in the GLB's display frame. */
export function fitDoorFloor(points: Float32Array, up: readonly [number, number, number]) {
  return fitGroundPlaneRobust(points, { up: [...up], ...FIT });
}

export async function loadDoorFixture() {
  const { points, alignment } = readGlbCloud(GLB);
  const buffer = readFileSync(NPZ);
  const arrays = await parseNpz(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  if (!arrays.extrinsics) throw new Error("fixture has no extrinsics");
  const up = transformDirection(estimateGravity(arrays.extrinsics.data).up, alignment);
  return { points, alignment, arrays, up };
}

describe.skipIf(!available)("maskless gate, door fixture at 504 px", () => {
  it("reads the recorded baseline off DA3's own cloud", async () => {
    const { points, up } = await loadDoorFixture();
    const grade = gradeTabletop(points, fitDoorFloor(points, up).plane);

    expect(grade.tabletopM).toBeCloseTo(GLB_BASELINE_M, 3);
    // Under-reads. MEASUREMENTS.md records the same sign on every graded object, which is why
    // the residual is treated there as scale bias rather than scatter.
    expect(grade.tabletopErrorM).toBeLessThan(0);
    expect(Math.abs(grade.tabletopErrorM)).toBeCloseTo(0.0506, 3);
  }, 30_000);

  it("rebuilds DA3's own cloud from the npz, to the millimetre", async () => {
    // The control arm. Same confidence floor DA3 used, so the ONLY difference from its export
    // is that we back-projected it ourselves. If this drifts, nothing downstream can be
    // trusted to mean what it says.
    const { points, alignment, arrays, up } = await loadDoorFixture();
    const rebuilt = buildCloud(framesFromArrays(arrays), {
      confidence: { kind: "absolute", minConfidence: 3.687 },
      weight: "none",
      maxRelativeDepthStep: 0,
      maxPoints: 1_000_000,
      transform: alignment,
    });

    const reference = fitDoorFloor(points, up);
    const theirs = gradeTabletop(points, reference.plane);
    const ours = gradeTabletop(rebuilt.positions, reference.plane);
    expect(Math.abs(ours.tabletopM - theirs.tabletopM)).toBeLessThan(TOLERANCE_M);
  }, 30_000);

  it("keeps the tabletop where it was when every pixel is kept", async () => {
    // The change this task exists to make. Over a FIXED floor, so the number answers only
    // whether the cloud's geometry survived — see the note at the top of this file.
    const { points, alignment, arrays, up } = await loadDoorFixture();
    const reference = fitDoorFloor(points, up);
    const baseline = gradeTabletop(points, reference.plane);

    for (const confidence of [
      { kind: "none" } as const,
      { kind: "da3-per-frame" } as const,
    ]) {
      const rebuilt = buildCloud(framesFromArrays(arrays), {
        confidence,
        weight: "rank",
        maxPoints: 1_000_000,
        transform: alignment,
      });
      const grade = gradeTabletop(rebuilt.positions, reference.plane);
      expect(Math.abs(grade.tabletopM - baseline.tabletopM)).toBeLessThan(TOLERANCE_M);
    }
  }, 60_000);

  it("gives every frame a real share of the cloud, which DA3's export does not", async () => {
    // The Gate in TASK.md: no frame may contribute under 20% of its usable pixels. DA3's
    // pooled floor wipes three frames of this fixture out entirely.
    const { alignment, arrays } = await loadDoorFixture();
    const frames = framesFromArrays(arrays);

    const pooled = buildCloud(frames, {
      confidence: { kind: "absolute", minConfidence: 3.687 },
      maxRelativeDepthStep: 0,
      transform: alignment,
    });
    const perFrame = buildCloud(frames, {
      confidence: { kind: "da3-per-frame" },
      maxRelativeDepthStep: 0,
      transform: alignment,
    });

    const share = (cloud: { frames: { kept: number; usable: number }[] }) =>
      Math.min(...cloud.frames.map((f) => (f.usable > 0 ? f.kept / f.usable : 1)));

    expect(share(pooled)).toBeLessThan(0.02);
    expect(share(perFrame)).toBeGreaterThan(0.2);
  }, 30_000);
});
