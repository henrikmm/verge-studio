/**
 * Where the phone actually was, put back into the scene you are looking at.
 *
 * DA3 returns a camera pose per frame, so the viewer can be placed exactly where the recording
 * camera stood and pointed the way it pointed. That turns the 3D pane from something you orbit
 * into something you can CHECK: at the same frame index, it and Depth 2D show the same viewpoint,
 * and a reconstruction that has drifted stops being a feeling and becomes a visible disagreement.
 *
 * ## The frame boundary this module exists to cross
 *
 * The poses in the result file are NOT in the coordinates of the cloud on screen. DA3 exports its
 * GLB into a display frame aligned to the first camera and records the transform between the two
 * as `scene.extras.hf_alignment` — which `point-cloud.ts` reads as `worldFromDa3`. A pose dropped
 * in without crossing that boundary lands somewhere plausible-looking and wrong.
 *
 * ## Why it is checked against the file rather than trusted
 *
 * DA3's GLB also carries its own camera frustums, one per frame, already in display space — the
 * `+ Cameras` toggle draws them. So there are two independent routes to the same answer, and they
 * can be compared. Measured 2026-08-07 across `door/504px-112f`, `room/504px-112f`,
 * `door/356px-256f` and the saved 99-frame run `20260806-193346`: the two agree to within
 * **0.004 mm** and 0.27°.
 *
 * That check is worth keeping at runtime, not just in a test. `worldFromDa3` falls back to the
 * identity when a GLB carries no alignment, which is harmless for everything that uses it today
 * and would be silently catastrophic here — the camera would be confidently placed in the wrong
 * part of the scene with nothing on screen saying so. When the two routes disagree, this module
 * refuses and says why, in keeping with the abstention rule the ground fit already follows.
 */

import * as THREE from "three";
import { estimateGravity, normalize, type GravityEstimate, type Vec3 } from "../../../geometry";
import { transformDirection, transformPoints } from "../graph/nodes/measurement";

/** Row-major 3×4 per frame, DA3's convention. */
const EXTRINSICS_STRIDE = 12;
/** Row-major 3×3 per frame. */
const INTRINSICS_STRIDE = 9;

export interface CameraPose {
  /** Index into the NPZ arrays, which is also the index the frame slider steps. */
  npzIndex: number;
  /** Camera centre in DISPLAY space — the same coordinates as the rendered cloud. */
  position: Vec3;
  /** Unit direction the camera looked, display space. */
  forward: Vec3;
  /** Unit up of the camera itself, display space. Not gravity: it rolls with the phone. */
  up: Vec3;
  /** Vertical field of view in degrees, from THIS frame's intrinsics. */
  vfovDeg: number;
  /** Horizontal field of view in degrees. */
  hfovDeg: number;
  /** Width ÷ height of the recorded frame. */
  aspect: number;
}

export type TrackCheck =
  /** Both routes agree. `maxErrorM` is the worst per-frame disagreement, in metres. */
  | { kind: "confirmed"; maxErrorM: number; toleranceM: number }
  /** The GLB carries no frustums to check against. Usable, but nothing corroborates it. */
  | { kind: "unverified"; reason: string }
  /** The routes disagree. The track must not be used to place a camera. */
  | { kind: "rejected"; reason: string };

export interface CameraTrack {
  poses: CameraPose[];
  /**
   * Up derived from the whole camera path, in display space, with the coherence that says whether
   * to believe it. Available even when the ground fit has refused, which is exactly when the
   * viewport needs a vertical to walk along.
   */
  gravity: GravityEstimate;
  check: TrackCheck;
}

/**
 * `p_camera = R·p_world + t`, so the centre is `-Rᵀ·t` and a camera axis in world coordinates is
 * the corresponding ROW of R. OpenCV puts +Z forward and +Y DOWN the image, which is why up is the
 * negated second row rather than the second row. Identical to the derivation in `geometry/gravity.ts`
 * — kept there for the parts that must stay free of Three.js and the display transform.
 */
function poseFromExtrinsics(extrinsics: ArrayLike<number>, frame: number) {
  const b = frame * EXTRINSICS_STRIDE;
  const t: Vec3 = [extrinsics[b + 3], extrinsics[b + 7], extrinsics[b + 11]];
  const centre: Vec3 = [
    -(extrinsics[b + 0] * t[0] + extrinsics[b + 4] * t[1] + extrinsics[b + 8] * t[2]),
    -(extrinsics[b + 1] * t[0] + extrinsics[b + 5] * t[1] + extrinsics[b + 9] * t[2]),
    -(extrinsics[b + 2] * t[0] + extrinsics[b + 6] * t[1] + extrinsics[b + 10] * t[2]),
  ];
  const forward: Vec3 = [extrinsics[b + 8], extrinsics[b + 9], extrinsics[b + 10]];
  const up: Vec3 = [-extrinsics[b + 4], -extrinsics[b + 5], -extrinsics[b + 6]];
  return { centre, forward, up };
}

export interface TrackSource {
  /** Row-major (N,3,4) world→camera. */
  extrinsics: ArrayLike<number>;
  /** Row-major (N,3,3). Expressed in DEPTH-MAP pixels, so they pair with the depth shape. */
  intrinsics: ArrayLike<number>;
  /** Depth-map dimensions, which are the pixel grid the intrinsics are written in. */
  imageWidth: number;
  imageHeight: number;
  /** Row-major 4×4 from `PointCloudValue.worldFromDa3`. */
  worldFromDa3: ArrayLike<number>;
}

/**
 * Poses in display space, one per frame, plus the vertical the path implies.
 *
 * The field of view is read per frame rather than once: DA3 re-estimates the intrinsics on every
 * frame and they drift a little (fy 253.5 → 257.6 across the door fixture's 112 frames). Pinning
 * one value would make the view subtly wrong at both ends of the clip.
 */
export function buildCameraTrack(source: TrackSource): Omit<CameraTrack, "check"> {
  const { extrinsics, intrinsics, imageWidth, imageHeight, worldFromDa3 } = source;
  const frameCount = Math.floor(extrinsics.length / EXTRINSICS_STRIDE);
  if (frameCount < 1 || extrinsics.length % EXTRINSICS_STRIDE !== 0) {
    throw new Error(
      `extrinsics must be (N,3,4) row-major — got ${extrinsics.length} values, ` +
        `which is not a multiple of ${EXTRINSICS_STRIDE}`,
    );
  }
  if (Math.floor(intrinsics.length / INTRINSICS_STRIDE) < frameCount) {
    throw new Error(
      `intrinsics cover ${Math.floor(intrinsics.length / INTRINSICS_STRIDE)} frames but ` +
        `extrinsics cover ${frameCount}`,
    );
  }
  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    throw new Error(`depth maps must have a positive size — got ${imageWidth}×${imageHeight}`);
  }

  const poses: CameraPose[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const { centre, forward, up } = poseFromExtrinsics(extrinsics, frame);
    const moved = transformPoints(Float32Array.from(centre), worldFromDa3);
    const displayForward = normalize(transformDirection(forward, worldFromDa3));
    const displayUp = normalize(transformDirection(up, worldFromDa3));
    if (!displayForward || !displayUp) {
      throw new Error(`frame ${frame} has a degenerate camera rotation`);
    }

    const k = frame * INTRINSICS_STRIDE;
    const fx = intrinsics[k];
    const fy = intrinsics[k + 4];
    if (!(Math.abs(fx) > 0) || !(Math.abs(fy) > 0)) {
      throw new Error(`frame ${frame} has a zero focal length`);
    }

    poses.push({
      npzIndex: frame,
      position: [moved[0], moved[1], moved[2]],
      forward: displayForward,
      up: displayUp,
      vfovDeg: (2 * Math.atan(imageHeight / (2 * Math.abs(fy))) * 180) / Math.PI,
      hfovDeg: (2 * Math.atan(imageWidth / (2 * Math.abs(fx))) * 180) / Math.PI,
      aspect: imageWidth / imageHeight,
    });
  }

  const raw = estimateGravity(extrinsics);
  const up = normalize(transformDirection(raw.up, worldFromDa3));
  if (!up) throw new Error("the camera-derived vertical is degenerate after the display transform");
  return { poses, gravity: { ...raw, up } };
}

/**
 * The camera positions DA3 drew into the GLB itself.
 *
 * Each frustum is eight line segments: four from the apex to the image corners, four closing the
 * rectangle. The apex is therefore the only vertex appearing four times, corners appearing three.
 * A tie means the geometry is not the frustum this assumes, and returns nothing rather than a
 * guess — an unverified track is honest, a wrongly verified one is not.
 */
export function frustumApexes(root: THREE.Object3D): Vec3[] {
  const apexes: Vec3[] = [];
  root.traverse((child) => {
    if (!(child instanceof THREE.Line)) return;
    const position = child.geometry.getAttribute("position");
    if (!position || position.count < 4) return;

    const tally = new Map<string, { count: number; point: Vec3 }>();
    for (let i = 0; i < position.count; i++) {
      const point: Vec3 = [position.getX(i), position.getY(i), position.getZ(i)];
      // Quantised to a micrometre so float noise cannot split one vertex into several.
      const key = point.map((value) => value.toFixed(6)).join(",");
      const entry = tally.get(key);
      if (entry) entry.count += 1;
      else tally.set(key, { count: 1, point });
    }

    const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
    if (ranked.length < 2 || ranked[0].count === ranked[1].count) return;

    // Frustums live under the same scene transform as the cloud, so a local vertex is only a
    // display-space point once that transform is applied.
    child.updateWorldMatrix(true, false);
    const world = new THREE.Vector3(...ranked[0].point).applyMatrix4(child.matrixWorld);
    apexes.push([world.x, world.y, world.z]);
  });
  return apexes;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Compare the computed track against the GLB's own frustums.
 *
 * Both the SET and the ORDER are checked, because they fail differently and only one of them is
 * visible. A wrong transform moves every camera and would be obvious; a permutation would place
 * the viewer at a real camera position belonging to a different moment, so the view would look
 * entirely reasonable while disagreeing with the frame slider driving it.
 *
 * The tolerance is enormous next to the 0.004 mm actually measured. It is sized to catch a broken
 * transform, which is metres out, not to police floating-point noise.
 */
export function verifyTrack(
  poses: readonly CameraPose[],
  apexes: readonly Vec3[],
  extent: number,
): TrackCheck {
  if (apexes.length === 0) {
    return { kind: "unverified", reason: "this scene carries no camera frustums to check against" };
  }
  if (apexes.length !== poses.length) {
    return {
      kind: "unverified",
      reason: `${apexes.length} frustums in the scene against ${poses.length} poses in the result file`,
    };
  }

  const toleranceM = Math.max(0.01, Math.abs(extent) * 0.002);
  let worstInOrder = 0;
  let worstNearest = 0;
  for (let i = 0; i < poses.length; i++) {
    worstInOrder = Math.max(worstInOrder, distance(poses[i].position, apexes[i]));
    let nearest = Infinity;
    for (const apex of apexes) nearest = Math.min(nearest, distance(poses[i].position, apex));
    worstNearest = Math.max(worstNearest, nearest);
  }

  if (worstInOrder <= toleranceM) return { kind: "confirmed", maxErrorM: worstInOrder, toleranceM };
  if (worstNearest <= toleranceM) {
    return {
      kind: "rejected",
      reason:
        "the camera positions are right but their order is not, so a pose would not match its frame",
    };
  }
  return {
    kind: "rejected",
    reason:
      `computed camera positions sit up to ${worstInOrder.toFixed(2)} m from the ones in the ` +
      `scene file, so the display transform cannot be trusted`,
  };
}

/** Build the track and check it in one step, which is how a caller should always use it. */
export function cameraTrack(source: TrackSource, glb: THREE.Object3D, extent: number): CameraTrack {
  const built = buildCameraTrack(source);
  return { ...built, check: verifyTrack(built.poses, frustumApexes(glb), extent) };
}

/**
 * The vertical field of view that shows the whole recorded frame in a pane of a different shape.
 *
 * The pane is never the shape of the video, so an exact match in both axes is impossible and one
 * of them has to give. Containing the frame is the right way to give: cropping would hide part of
 * what the camera saw inside a mode whose entire claim is showing what the camera saw.
 */
export function fitFovDeg(pose: CameraPose, paneAspect: number): number {
  const vertical = (pose.vfovDeg * Math.PI) / 180;
  const horizontal = (pose.hfovDeg * Math.PI) / 180;
  if (!(paneAspect > 0)) return pose.vfovDeg;
  // Widening the pane past the clip's own aspect leaves vertical as the binding constraint;
  // narrower than that, the horizontal field is what runs out first.
  const neededForWidth = 2 * Math.atan(Math.tan(horizontal / 2) / paneAspect);
  return (Math.max(vertical, neededForWidth) * 180) / Math.PI;
}

/**
 * The camera's orientation as a rotation, for a viewer that has to be placed exactly.
 *
 * `Matrix4.lookAt` already accounts for a Three.js camera looking down its own -Z, so it takes the
 * point to look AT — one step along the recorded forward. Going through it rather than composing
 * the three axes by hand also orthonormalises them, so a pose carrying slight float drift still
 * yields a valid rotation instead of a subtly sheared one.
 */
export function poseOrientation(pose: CameraPose): THREE.Quaternion {
  const eye = new THREE.Vector3(...pose.position);
  const target = eye.clone().add(new THREE.Vector3(...pose.forward));
  const matrix = new THREE.Matrix4().lookAt(eye, target, new THREE.Vector3(...pose.up));
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
}

/** How far the free look may pitch from level before it would tip over its own pole. */
export const LOOK_PITCH_LIMIT = Math.PI / 2 - 0.02;

/**
 * The recorded orientation, turned by however much the operator has looked around.
 *
 * Standing where the camera stood is the claim the fixed view makes; being unable to turn your
 * head while standing there is merely a limitation, so the look offset is applied ON TOP of the
 * pose rather than replacing it. Yaw is applied in WORLD space about the measured vertical, so
 * turning stays level even for a clip recorded with the phone rolled; pitch is applied in the
 * camera's own frame, so looking up means up relative to the picture.
 */
export function aimedOrientation(
  pose: CameraPose,
  up: Vec3,
  yaw: number,
  pitch: number,
): THREE.Quaternion {
  const clamped = Math.min(LOOK_PITCH_LIMIT, Math.max(-LOOK_PITCH_LIMIT, pitch));
  const world = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...up).normalize(), yaw);
  const local = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), clamped);
  return world.multiply(poseOrientation(pose)).multiply(local);
}

/**
 * Where the recorded frame sits inside the pane, as fractions of its width and height.
 *
 * `fitFovDeg` contains the whole frame rather than cropping it, which means the frame occupies
 * only part of a pane that is not its shape. Everything belonging to the video — the boundary
 * marker, and the ghosted frame itself — has to land in exactly that rectangle, or the overlay
 * would claim an alignment it does not have.
 */
export function recordedFrameRect(
  pose: CameraPose,
  paneAspect: number,
): { widthFraction: number; heightFraction: number } {
  const fitted = Math.tan((fitFovDeg(pose, paneAspect) * Math.PI) / 360);
  if (!(fitted > 0) || !(paneAspect > 0)) return { widthFraction: 1, heightFraction: 1 };
  return {
    heightFraction: Math.min(1, Math.tan((pose.vfovDeg * Math.PI) / 360) / fitted),
    widthFraction: Math.min(1, Math.tan((pose.hfovDeg * Math.PI) / 360) / (fitted * paneAspect)),
  };
}

/**
 * Smoothstep, used to ease between two poses while the frame slider moves.
 *
 * Measured frame-to-frame motion on the fixtures is a median 5–31 cm and up to 14° of turn, so
 * snapping reads as a glitch rather than as camera movement. Easing in and out — rather than a
 * straight lerp — is what makes a short transition read as a deliberate move.
 */
export function ease(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}
