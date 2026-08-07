/**
 * Putting the recording camera back into the displayed scene.
 *
 * Two things here are worth pinning hard, because both fail invisibly.
 *
 * The first is the display transform. A pose that skips `hf_alignment` lands somewhere entirely
 * plausible — inside the same cloud, at a sensible height, looking at real geometry — and is
 * simply not where the camera was. Nothing on screen would say so.
 *
 * The second is frame ORDER. A permutation puts the viewer at a genuine camera position from a
 * different moment of the clip, so the picture stays convincing while quietly disagreeing with the
 * frame slider that produced it. `verifyTrack` is tested for both, separately.
 *
 * The last block is the one that matters most: the same comparison run against a real DA3 export,
 * where the answer comes from the file rather than from this code's own assumptions. It skips when
 * the payloads are absent — `fixtures/door/**` is gitignored, and a test that fails on a fresh
 * clone would train everyone to ignore red.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  buildCameraTrack,
  cameraTrack,
  ease,
  fitFovDeg,
  frustumApexes,
  poseOrientation,
  recordedFrameRect,
  aimedOrientation,
  verifyTrack,
  type CameraPose,
} from "./camera-track";
import { parseNpz } from "../lib/npz";
import { angleBetweenDeg, type Vec3 } from "../../../geometry";

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * One frame of a camera at the origin looking along world +Z, held upright.
 *
 * R = I means the camera's axes ARE the world axes: +Z forward, +Y down the image. So the world-up
 * this should recover is -Y, and the centre is the origin.
 */
const IDENTITY_POSE = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

/** fx = fy = 100 on a 200×100 image: a 45° half-angle both ways, so 90° horizontally. */
const SIMPLE_K = Float32Array.from([100, 0, 100, 0, 100, 50, 0, 0, 1]);

const SOURCE = {
  extrinsics: IDENTITY_POSE,
  intrinsics: SIMPLE_K,
  imageWidth: 200,
  imageHeight: 100,
  worldFromDa3: IDENTITY,
};

/** A frustum as DA3 writes it: four edges from the apex, four closing the far rectangle. */
function frustum(apex: Vec3, forward: Vec3 = [0, 0, 1]): THREE.Line {
  const [fx, fy, fz] = forward;
  const corners: Vec3[] = [
    [apex[0] + fx - 0.3, apex[1] + fy - 0.2, apex[2] + fz],
    [apex[0] + fx + 0.3, apex[1] + fy - 0.2, apex[2] + fz],
    [apex[0] + fx + 0.3, apex[1] + fy + 0.2, apex[2] + fz],
    [apex[0] + fx - 0.3, apex[1] + fy + 0.2, apex[2] + fz],
  ];
  const vertices: number[] = [];
  for (const corner of corners) vertices.push(...apex, ...corner);
  for (let i = 0; i < 4; i++) vertices.push(...corners[i], ...corners[(i + 1) % 4]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  return new THREE.LineSegments(geometry);
}

function sceneOf(...apexes: Vec3[]): THREE.Group {
  const group = new THREE.Group();
  const points = new THREE.Points(new THREE.BufferGeometry());
  group.add(points);
  for (const apex of apexes) group.add(frustum(apex));
  return group;
}

describe("buildCameraTrack", () => {
  it("recovers the camera centre and the direction it looked", () => {
    const { poses } = buildCameraTrack(SOURCE);
    expect(poses).toHaveLength(1);
    expect(poses[0].position).toEqual([0, 0, 0]);
    expect(poses[0].forward).toEqual([0, 0, 1]);
    // OpenCV's +Y runs DOWN the image, so the camera's up is world -Y.
    expect(poses[0].up).toEqual([-0, -1, -0]);
  });

  it("places a translated camera at -R'.t, not at t", () => {
    // R = I, t = (1,2,3) means the camera sits at (-1,-2,-3). Using t directly — the mistake this
    // guards — would put it at the mirror image, still inside the scene and still plausible.
    const extrinsics = Float32Array.from([1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3]);
    const { poses } = buildCameraTrack({ ...SOURCE, extrinsics });
    expect(poses[0].position).toEqual([-1, -2, -3]);
  });

  it("crosses into display space instead of leaving poses in the result file's frame", () => {
    // A quarter turn about x plus a shift: y → z, z → -y.
    const worldFromDa3 = Float32Array.from([1, 0, 0, 5, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    const extrinsics = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -2]);
    const { poses } = buildCameraTrack({ ...SOURCE, extrinsics, worldFromDa3 });
    // Camera at (0,0,2) in DA3 space lands at (5,-2,0) after the transform.
    expect(poses[0].position[0]).toBeCloseTo(5, 9);
    expect(poses[0].position[1]).toBeCloseTo(-2, 9);
    expect(poses[0].position[2]).toBeCloseTo(0, 9);
    // Forward +Z becomes -Y; directions must not pick up the translation.
    expect(poses[0].forward[1]).toBeCloseTo(-1, 9);
  });

  it("reads the field of view from each frame's own intrinsics", () => {
    const { poses } = buildCameraTrack(SOURCE);
    expect(poses[0].hfovDeg).toBeCloseTo(90, 6);
    expect(poses[0].vfovDeg).toBeCloseTo(53.1301, 3);
    expect(poses[0].aspect).toBeCloseTo(2, 9);
  });

  it("lets the field of view drift frame to frame, as DA3 re-estimates it", () => {
    const extrinsics = Float32Array.from([...IDENTITY_POSE, ...IDENTITY_POSE]);
    const wider = Float32Array.from([80, 0, 100, 0, 80, 50, 0, 0, 1]);
    const { poses } = buildCameraTrack({
      ...SOURCE,
      extrinsics,
      intrinsics: Float32Array.from([...SIMPLE_K, ...wider]),
    });
    expect(poses[1].vfovDeg).toBeGreaterThan(poses[0].vfovDeg);
  });

  it("derives a vertical from the whole path, in display space", () => {
    const { gravity } = buildCameraTrack(SOURCE);
    expect(gravity.up).toEqual([-0, -1, -0]);
    expect(gravity.coherence).toBeCloseTo(1, 9);
  });

  it("rejects malformed inputs rather than producing plausible nonsense", () => {
    expect(() => buildCameraTrack({ ...SOURCE, extrinsics: new Float32Array(7) })).toThrow(/3,4/);
    expect(() =>
      buildCameraTrack({ ...SOURCE, extrinsics: Float32Array.from([...IDENTITY_POSE, ...IDENTITY_POSE]) }),
    ).toThrow(/intrinsics cover/);
    expect(() => buildCameraTrack({ ...SOURCE, imageHeight: 0 })).toThrow(/positive size/);
    expect(() =>
      buildCameraTrack({ ...SOURCE, intrinsics: Float32Array.from([0, 0, 100, 0, 0, 50, 0, 0, 1]) }),
    ).toThrow(/focal length/);
  });
});

describe("frustumApexes", () => {
  it("finds the apex of each frustum and ignores the point cloud", () => {
    const apexes = frustumApexes(sceneOf([1, 2, 3], [4, 5, 6]));
    expect(apexes).toHaveLength(2);
    expect(apexes[0][0]).toBeCloseTo(1, 6);
    expect(apexes[1][2]).toBeCloseTo(6, 6);
  });

  it("returns them in display space, with the scene transform applied", () => {
    const group = sceneOf([1, 0, 0]);
    group.position.set(10, 0, 0);
    group.updateMatrixWorld(true);
    expect(frustumApexes(group)[0][0]).toBeCloseTo(11, 6);
  });

  it("declines geometry that is not the frustum it assumes", () => {
    // A closed square: every vertex appears exactly twice, so there is no apex to find.
    const geometry = new THREE.BufferGeometry();
    const square = [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0];
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(square, 3));
    const group = new THREE.Group();
    group.add(new THREE.LineSegments(geometry));
    expect(frustumApexes(group)).toEqual([]);
  });
});

describe("verifyTrack", () => {
  const pose = (position: Vec3): CameraPose => ({
    npzIndex: 0,
    position,
    forward: [0, 0, 1],
    up: [0, 1, 0],
    vfovDeg: 50,
    hfovDeg: 80,
    aspect: 1.6,
  });

  it("confirms a track that matches the scene file", () => {
    const check = verifyTrack([pose([1, 2, 3]), pose([4, 5, 6])], [[1, 2, 3], [4, 5, 6]], 10);
    expect(check.kind).toBe("confirmed");
    if (check.kind === "confirmed") expect(check.maxErrorM).toBeCloseTo(0, 9);
  });

  it("rejects a track whose frames are in the wrong order", () => {
    // Every position is real, so a set-only check would pass this and the viewer would sit at a
    // genuine camera pose belonging to a different moment of the clip.
    const check = verifyTrack([pose([1, 2, 3]), pose([4, 5, 6])], [[4, 5, 6], [1, 2, 3]], 10);
    expect(check.kind).toBe("rejected");
    if (check.kind === "rejected") expect(check.reason).toMatch(/order/);
  });

  it("rejects a track built with the wrong transform", () => {
    const check = verifyTrack([pose([1, 2, 3])], [[9, 9, 9]], 10);
    expect(check.kind).toBe("rejected");
    if (check.kind === "rejected") expect(check.reason).toMatch(/display transform/);
  });

  it("reports an unverified track rather than pretending it checked", () => {
    expect(verifyTrack([pose([0, 0, 0])], [], 10).kind).toBe("unverified");
    const mismatch = verifyTrack([pose([0, 0, 0])], [[0, 0, 0], [1, 1, 1]], 10);
    expect(mismatch.kind).toBe("unverified");
  });

  it("scales its tolerance with the scene, with a floor for tiny ones", () => {
    // 1 cm of slack in a 1 m scene; 0.2% of a large one.
    expect(verifyTrack([pose([0, 0, 0])], [[0, 0, 0.009]], 1).kind).toBe("confirmed");
    expect(verifyTrack([pose([0, 0, 0])], [[0, 0, 0.02]], 1).kind).toBe("rejected");
    expect(verifyTrack([pose([0, 0, 0])], [[0, 0, 0.09]], 100).kind).toBe("confirmed");
  });
});

describe("fitFovDeg", () => {
  const pose: CameraPose = {
    npzIndex: 0,
    position: [0, 0, 0],
    forward: [0, 0, 1],
    up: [0, 1, 0],
    vfovDeg: (2 * Math.atan(50 / 100) * 180) / Math.PI,
    hfovDeg: 90,
    aspect: 2,
  };

  it("keeps the recorded vertical field when the pane is wider than the clip", () => {
    expect(fitFovDeg(pose, 3)).toBeCloseTo(pose.vfovDeg, 6);
  });

  it("opens up rather than cropping when the pane is narrower than the clip", () => {
    const fitted = fitFovDeg(pose, 1);
    expect(fitted).toBeGreaterThan(pose.vfovDeg);
    // At a square pane the horizontal field is the binding one, so it must be preserved exactly.
    expect(fitted).toBeCloseTo(pose.hfovDeg, 6);
  });

  it("matches exactly at the clip's own aspect ratio", () => {
    expect(fitFovDeg(pose, pose.aspect)).toBeCloseTo(pose.vfovDeg, 6);
  });

  it("survives a pane with no width yet", () => {
    expect(fitFovDeg(pose, 0)).toBeCloseTo(pose.vfovDeg, 6);
  });
});

describe("poseOrientation", () => {
  it("aims a Three.js camera along the direction DA3 recorded", () => {
    const pose: CameraPose = {
      npzIndex: 0,
      position: [1, 2, 3],
      forward: [0, 0, 1],
      up: [0, 1, 0],
      vfovDeg: 50,
      hfovDeg: 80,
      aspect: 1.6,
    };
    // A Three.js camera looks down its own -Z, so the recorded forward must come back out of the
    // rotation's -Z axis. Getting this backwards points the fixed view 180° away from the scene.
    const looked = new THREE.Vector3(0, 0, -1).applyQuaternion(poseOrientation(pose));
    expect(angleBetweenDeg([looked.x, looked.y, looked.z], pose.forward)).toBeCloseTo(0, 6);
  });
});

describe("aimedOrientation", () => {
  const pose: CameraPose = {
    npzIndex: 0,
    position: [0, 0, 0],
    forward: [0, 0, -1],
    up: [0, 1, 0],
    vfovDeg: 50,
    hfovDeg: 80,
    aspect: 1.6,
  };
  const looking = (yaw: number, pitch: number): Vec3 => {
    const v = new THREE.Vector3(0, 0, -1).applyQuaternion(aimedOrientation(pose, [0, 1, 0], yaw, pitch));
    return [v.x, v.y, v.z];
  };

  it("leaves the recorded direction alone with no look applied", () => {
    expect(angleBetweenDeg(looking(0, 0), pose.forward)).toBeCloseTo(0, 6);
  });

  it("turns left on a positive yaw and stays level while doing it", () => {
    const turned = looking(Math.PI / 2, 0);
    expect(turned[0]).toBeCloseTo(-1, 6);
    expect(turned[1]).toBeCloseTo(0, 6);
  });

  it("looks up on a positive pitch", () => {
    expect(looking(0, 0.4)[1]).toBeGreaterThan(0);
    expect(looking(0, -0.4)[1]).toBeLessThan(0);
  });

  it("stops short of straight up rather than flipping the view over", () => {
    const far = looking(0, 99);
    expect(angleBetweenDeg(far, [0, 1, 0])).toBeGreaterThan(0.5);
    expect(Number.isFinite(far[0])).toBe(true);
  });

  it("yaws about the measured vertical, not the scene's, so a rolled clip still turns level", () => {
    const up = [0, Math.cos(0.4), Math.sin(0.4)] as Vec3;
    const rolled: CameraPose = { ...pose, up };
    const before = new THREE.Vector3(0, 0, -1).applyQuaternion(aimedOrientation(rolled, up, 0, 0));
    const after = new THREE.Vector3(0, 0, -1).applyQuaternion(aimedOrientation(rolled, up, 0.6, 0));
    // Turning must not change how far the view sits from the vertical.
    const tilt = (v: THREE.Vector3) => angleBetweenDeg([v.x, v.y, v.z], up);
    expect(tilt(after)).toBeCloseTo(tilt(before), 6);
  });
});

describe("recordedFrameRect", () => {
  const pose: CameraPose = {
    npzIndex: 0,
    position: [0, 0, 0],
    forward: [0, 0, -1],
    up: [0, 1, 0],
    vfovDeg: (2 * Math.atan(50 / 100) * 180) / Math.PI,
    hfovDeg: 90,
    aspect: 2,
  };

  it("fills the pane exactly when the pane is the clip's shape", () => {
    const rect = recordedFrameRect(pose, pose.aspect);
    expect(rect.widthFraction).toBeCloseTo(1, 6);
    expect(rect.heightFraction).toBeCloseTo(1, 6);
  });

  it("leaves the frame short of the sides in a wider pane, and never taller", () => {
    const rect = recordedFrameRect(pose, 4);
    expect(rect.heightFraction).toBeCloseTo(1, 6);
    expect(rect.widthFraction).toBeLessThan(1);
    expect(rect.widthFraction).toBeGreaterThan(0.4);
  });

  it("leaves it short of the top and bottom in a narrower pane", () => {
    const rect = recordedFrameRect(pose, 1);
    expect(rect.widthFraction).toBeCloseTo(1, 6);
    expect(rect.heightFraction).toBeLessThan(1);
  });

  it("never claims more than the whole pane, whatever the shape", () => {
    for (const aspect of [0.1, 0.5, 1, 2, 8, 0]) {
      const rect = recordedFrameRect(pose, aspect);
      expect(rect.widthFraction).toBeLessThanOrEqual(1);
      expect(rect.heightFraction).toBeLessThanOrEqual(1);
      expect(rect.widthFraction).toBeGreaterThan(0);
    }
  });
});

describe("ease", () => {
  it("starts and ends at rest, and clamps outside its range", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 9);
    expect(ease(-1)).toBe(0);
    expect(ease(4)).toBe(1);
    // Slower at the ends than a straight line, which is what makes a short move read as a move.
    expect(ease(0.1)).toBeLessThan(0.1);
    expect(ease(0.9)).toBeGreaterThan(0.9);
  });
});

/* ------------------------------------------------------------------ *
 * The same check against real DA3 output, where the answer is in the file.
 * ------------------------------------------------------------------ */

const FIXTURE = new URL("../../../fixtures/door/504px-112f/", import.meta.url);
const NPZ = fileURLToPath(new URL("verge-result.npz", FIXTURE));
const GLB = fileURLToPath(new URL("scene.glb", FIXTURE));
const available = existsSync(NPZ) && existsSync(GLB);

/**
 * Minimal GLB reader — deliberately not the app's GLTFLoader, which needs a DOM.
 *
 * Being a second implementation is a feature here: it means the fixture case compares the app's
 * arithmetic against the file as parsed by something that shares none of its assumptions.
 */
function readGlb(path: string): { alignment: Float32Array; scene: THREE.Group } {
  const buffer = readFileSync(path);
  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8"));
  const binOffset = 20 + jsonLength + 8;

  const alignment = Float32Array.from(
    (gltf.scenes[gltf.scene ?? 0].extras.hf_alignment as number[][]).flat(),
  );
  const scene = new THREE.Group();
  for (const node of gltf.nodes ?? []) {
    const mesh = gltf.meshes?.[node.mesh];
    for (const primitive of mesh?.primitives ?? []) {
      if (primitive.mode !== 1) continue; // 1 = LINES, the camera frustums
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      const view = gltf.bufferViews[accessor.bufferView];
      const offset = binOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const positions = new Float32Array(
        buffer.buffer.slice(
          buffer.byteOffset + offset,
          buffer.byteOffset + offset + accessor.count * 12,
        ),
      );
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      scene.add(new THREE.LineSegments(geometry));
    }
  }
  return { alignment, scene };
}

describe.skipIf(!available)("against the door fixture", () => {
  it("agrees with the camera positions DA3 wrote into the scene file", async () => {
    const arrays = await parseNpz(
      readFileSync(NPZ).buffer.slice(0) as ArrayBuffer,
    );
    const { alignment, scene } = readGlb(GLB);
    const [, height, width] = arrays.depth.shape;

    const track = cameraTrack(
      {
        extrinsics: arrays.extrinsics.data,
        intrinsics: arrays.intrinsics.data,
        imageWidth: width,
        imageHeight: height,
        worldFromDa3: alignment,
      },
      scene,
      5,
    );

    expect(track.poses).toHaveLength(112);
    expect(track.check.kind).toBe("confirmed");
    // Measured 2026-08-07 at 1 micrometre. Asserting a millimetre leaves room for a rebuild of
    // the fixture without loosening this into a check that could pass on a broken transform.
    if (track.check.kind === "confirmed") expect(track.check.maxErrorM).toBeLessThan(1e-3);
  });

  it("recovers a portrait clip's shape and a handheld walk's vertical", async () => {
    const arrays = await parseNpz(readFileSync(NPZ).buffer.slice(0) as ArrayBuffer);
    const { alignment } = readGlb(GLB);
    const [, height, width] = arrays.depth.shape;
    const { poses, gravity } = buildCameraTrack({
      extrinsics: arrays.extrinsics.data,
      intrinsics: arrays.intrinsics.data,
      imageWidth: width,
      imageHeight: height,
      worldFromDa3: alignment,
    });

    expect(poses[0].aspect).toBeCloseTo(280 / 504, 6);
    // A walkthrough held roughly upright: the frames agree strongly about which way down is.
    expect(gravity.coherence).toBeGreaterThan(0.9);
    // ...and that vertical is 9.6° off the scene's own +Y, which is why walking cannot use +Y.
    expect(angleBetweenDeg(gravity.up, [0, 1, 0])).toBeGreaterThan(5);
  });
});
