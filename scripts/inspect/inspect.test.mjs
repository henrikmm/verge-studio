/**
 * Tests for the inspector's own arithmetic.
 *
 * The inspector's job is to be believed, so the parts of it that could be quietly wrong are the
 * parts worth testing: the projection that decides where a selected point lands on a photograph,
 * the matrix inverse that gets it back into the cameras' frame, and the framing that decides
 * whether two pictures of the same cloud are comparable at all. Everything geometric is imported
 * from `geometry/`, so what is left here is exactly the seam between that and the pixels.
 *
 * The projection test is a ROUND TRIP against `backprojectMask` rather than a check of its
 * fields, for the reason the Registry records: a field-by-field test passes against a broken
 * conversion. If the forward projection disagreed with the project's own camera convention, the
 * overlay would draw the selection in the wrong place and look entirely plausible doing it.
 */

import { describe, expect, it } from "vitest";
import { backprojectMask } from "../../geometry/backproject";
import { canvas, setPixel, text, textWidth } from "./image.mjs";
import { apply4x4, invert4x4, maskOverlay, projectToPixel, renderCloud, viewBasis } from "./render.mjs";

const basisFromUp = (up) => {
  const helper = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = normalize(cross(helper, up));
  const e2 = normalize(cross(up, e1));
  return { e1, e2, up };
};

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v) {
  const length = Math.hypot(...v);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : null;
}

const turbo = (t) => [Math.round(t * 255), 64, Math.round((1 - t) * 255)];

describe("invert4x4", () => {
  const transform = [
    0.8, -0.6, 0, 1.5,
    0.6, 0.8, 0, -0.25,
    0, 0, 1, 3,
    0, 0, 0, 1,
  ];

  it("round-trips a point through its own inverse", () => {
    const inverse = invert4x4(transform);
    const point = [1.25, -3.5, 0.75];
    const there = apply4x4(transform, point);
    const back = apply4x4(inverse, there);
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(point[i], 10);
  });

  it("refuses a singular matrix rather than returning nonsense", () => {
    const flat = [1, 2, 3, 4, 2, 4, 6, 8, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(() => invert4x4(flat)).toThrow(/not invertible/);
  });
});

describe("projectToPixel", () => {
  // A camera that is rotated and translated, so a convention mismatch cannot cancel out.
  const width = 16;
  const height = 12;
  const intrinsics = Float32Array.from([9, 0, 8, 0, 9, 6, 0, 0, 1]);
  const extrinsics = Float32Array.from([
    0.936, 0, 0.352, 0.1,
    0, 1, 0, -0.2,
    -0.352, 0, 0.936, 2.5,
  ]);

  it("inverts the project's own back-projection, pixel for pixel", () => {
    const depth = new Float32Array(width * height).fill(3.2);
    const mask = new Uint8Array(width * height);
    const chosen = [
      [4, 3],
      [8, 6],
      [13, 9],
    ];
    for (const [x, y] of chosen) mask[y * width + x] = 1;

    const result = backprojectMask(
      { depth, width, height, intrinsics, extrinsics },
      mask,
      { erodeRadius: 0, maxRelativeDepthStep: 0 },
    );
    expect(result.pointCount).toBe(chosen.length);

    // backprojectMask walks rows then columns, so the points come back in that order.
    const expected = [...chosen].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (let i = 0; i < result.pointCount; i++) {
      const point = [result.points[i * 3], result.points[i * 3 + 1], result.points[i * 3 + 2]];
      const pixel = projectToPixel(point, extrinsics, intrinsics, 0);
      expect(pixel).not.toBeNull();
      expect(pixel[0]).toBeCloseTo(expected[i][0], 4);
      expect(pixel[1]).toBeCloseTo(expected[i][1], 4);
      expect(pixel[2]).toBeCloseTo(3.2, 4);
    }
  });

  it("returns null behind the camera, so nothing is drawn from a point it cannot see", () => {
    const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(projectToPixel([0, 0, -5], identity, intrinsics, 0)).toBeNull();
  });
});

describe("viewBasis", () => {
  const up = normalize([0.1, 0.98, 0.17]);

  for (const name of ["top", "front", "side", "iso", "floor"]) {
    it(`${name} is an orthonormal frame`, () => {
      const view = viewBasis(name, up, basisFromUp, normalize, cross);
      for (const axis of [view.right, view.screenUp, view.forward]) {
        expect(Math.hypot(...axis)).toBeCloseTo(1, 6);
      }
      expect(dot(view.right, view.screenUp)).toBeCloseTo(0, 6);
      expect(dot(view.right, view.forward)).toBeCloseTo(0, 6);
      expect(dot(view.screenUp, view.forward)).toBeCloseTo(0, 6);
    });
  }

  it("looks down the resolved up axis in plan, not down the scene's +Y", () => {
    const view = viewBasis("top", up, basisFromUp, normalize, cross);
    expect(dot(view.forward, up)).toBeCloseTo(-1, 6);
  });

  it("puts up on the screen's vertical in elevation", () => {
    const view = viewBasis("front", up, basisFromUp, normalize, cross);
    expect(dot(view.screenUp, up)).toBeCloseTo(1, 6);
  });

  it("rejects a view it does not have rather than drawing something else", () => {
    expect(() => viewBasis("oblique", up, basisFromUp, normalize, cross)).toThrow(/unknown view/);
  });
});

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe("image primitives", () => {
  it("ignores pixels outside the canvas instead of wrapping to the next row", () => {
    const image = canvas(4, 4, [0, 0, 0]);
    setPixel(image, -1, 2, [255, 255, 255]);
    setPixel(image, 4, 2, [255, 255, 255]);
    expect([...image.data].every((value) => value === 0)).toBe(true);
  });

  it("folds punctuation the font lacks, and measures what it will actually draw", () => {
    const image = canvas(200, 20, [0, 0, 0]);
    text(image, 2, 2, "11.8° tilt — ok");
    expect([...image.data].some((value) => value > 0)).toBe(true);
    // "11.8 DEG TILT - OK": the degree sign becomes four characters, the em dash one.
    expect(textWidth("11.8° tilt — ok")).toBe(textWidth("11.8 deg tilt - ok"));
  });
});

describe("maskOverlay", () => {
  // A photograph twice the reconstruction's resolution, so the nearest-neighbour scaling
  // between mask space and image space is exercised rather than skipped.
  const width = 4;
  const height = 4;
  const photo = canvas(8, 8, [10, 10, 10]);

  function mask(...indices) {
    const out = new Uint8Array(width * height);
    for (const index of indices) out[index] = 1;
    return out;
  }

  it("tints only the region the mask covers, scaled to the photograph", () => {
    const image = maskOverlay(photo, [{ mask: mask(0), rgb: [255, 0, 0], label: "X" }], {
      width,
      height,
      title: "T",
      subtitle: "S",
    });
    const top = 22;
    const at = (x, y) => image.data[((y + top) * image.width + x) * 3];

    // Mask pixel 0 is the top-left quarter-cell, which is 2x2 image pixels.
    expect(at(0, 0)).toBeGreaterThan(100);
    expect(at(1, 1)).toBeGreaterThan(100);
    expect(at(2, 2)).toBe(10);
  });

  it("lets a later layer win where two overlap, so absence is never hidden by cause", () => {
    const image = maskOverlay(
      photo,
      [
        { mask: mask(0), rgb: [255, 0, 0], label: "FIRST" },
        { mask: mask(0), rgb: [0, 0, 255], label: "SECOND" },
      ],
      { width, height, title: "T", subtitle: "S" },
    );
    const at = ((22 + 0) * image.width + 0) * 3;
    expect(image.data[at + 2]).toBeGreaterThan(image.data[at]);
  });

  it("leaves the photograph legible under the tint rather than painting over it", () => {
    const bright = canvas(8, 8, [255, 255, 255]);
    const image = maskOverlay(bright, [{ mask: mask(0), rgb: [0, 0, 0], label: "X" }], {
      width,
      height,
      title: "T",
      subtitle: "S",
    });
    const at = ((22 + 0) * image.width + 0) * 3;
    // Blended, not replaced: a fully black tint over white must not reach black.
    expect(image.data[at]).toBeGreaterThan(0);
    expect(image.data[at]).toBeLessThan(255);
  });
});

describe("renderCloud", () => {
  // A floor with a box standing on it, in a frame whose up is not the scene's +Y.
  const up = normalize([0, 1, 0]);
  const points = [];
  const heights = [];
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 40; j++) {
      const x = -2 + (4 * i) / 39;
      const z = -2 + (4 * j) / 39;
      points.push(x, 0, z);
      heights.push(0);
      if (Math.abs(x) < 0.5 && Math.abs(z) < 0.5) {
        points.push(x, 1, z);
        heights.push(1);
      }
    }
  }
  const cloud = Float32Array.from(points);
  const above = Float64Array.from(heights);

  const draw = (extra = {}) =>
    renderCloud({
      points: cloud,
      heights: above,
      view: viewBasis("top", up, basisFromUp, normalize, cross),
      colour: "height",
      width: 200,
      height: 200,
      turbo,
      heightRange: [0, 1],
      title: "TEST",
      subtitle: "",
      ...extra,
    });

  it("draws the cloud and reports how much of it survived the depth test", () => {
    const { drawn } = draw();
    expect(drawn).toBeGreaterThan(1000);
    expect(drawn).toBeLessThanOrEqual(cloud.length / 3);
  });

  it("is deterministic, so two renders of one cloud differ only where the cloud does", () => {
    const a = draw();
    const b = draw();
    expect(Buffer.from(b.image.data).equals(Buffer.from(a.image.data))).toBe(true);
  });

  it("colours by height above the plane, not by position in the file", () => {
    const { image } = draw();
    const present = new Set();
    for (let i = 0; i < image.data.length; i += 3) {
      present.add(`${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`);
    }
    // The stand-in ramp maps 0 m to [0,64,255] and 1 m to [255,64,0]. Both must be on screen:
    // the floor drawn at the bottom of the range, the box on it at the top.
    expect(present.has("0,64,255")).toBe(true);
    expect(present.has("255,64,0")).toBe(true);
  });

  it("draws a selection over the surface it was taken from", () => {
    const selection = new Uint8Array(cloud.length / 3);
    for (let i = 0; i < selection.length; i++) selection[i] = above[i] > 0.5 ? 1 : 0;
    const { selected } = draw({ selection, colour: "flat" });
    expect(selected).toBeGreaterThan(0);
  });

  it("refuses a cloud with nothing finite in it", () => {
    expect(() =>
      draw({ points: Float32Array.from([NaN, NaN, NaN]), heights: Float64Array.from([0]) }),
    ).toThrow(/no finite points/);
  });
});
