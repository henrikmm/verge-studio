// Turning a reconstruction into a picture, without a GPU and without a browser.
//
// A point cloud is a list of coordinates; drawing one is arithmetic, not rendering. Projecting
// it here rather than screenshotting the viewport buys three things the viewport cannot:
//
//   * **The framing is derived, not dragged.** Two runs, or one run before and after a change,
//     are photographed from exactly the same place, so a difference in the image is a difference
//     in the geometry.
//   * **Colour can carry evidence instead of appearance.** Height above the fitted floor, floor
//     inliers, a selection — none of which the viewport draws, and all of which are the actual
//     question when a measurement comes out wrong.
//   * **It runs where the numbers run.** The same command prints the support fraction and draws
//     the plane it belongs to, so the two can never describe different fits.
//
// It is not a replacement for looking at the app. It is what to reach for when the question is
// "what is actually in this cloud", which is most questions.

import {
  BACKGROUND,
  DIM,
  INK,
  badge,
  blit,
  canvas,
  fillRect,
  line,
  setPixel,
  strokeRect,
  text,
  textWidth,
} from "./image.mjs";

/** The camera-port pink from DESIGN.md's legend. Camera data, wherever it is drawn. */
export const CAMERA_RGB = [232, 121, 160];
/** The selection colour. Deliberately not on the app's ramp: this is an inspector's mark. */
export const SELECT_RGB = [255, 64, 200];

const MARGIN = { left: 52, right: 14, top: 26, bottom: 46 };

export const VIEWS = ["top", "front", "side", "iso", "floor"];
export const COLOURS = ["rgb", "height", "inlier", "flat"];

/**
 * An orthographic camera as three world-space axes.
 *
 * Built from the resolved up axis rather than from the scene's own +Y, because DA3 aligns its
 * export to the FIRST CAMERA and not to gravity — measured at 33.2° off true up on the room clip.
 * A "top" view down the wrong axis would look plausible and be a lie.
 */
export function viewBasis(name, up, basisFromUp, normalize, cross) {
  const { e1, e2 } = basisFromUp(up);
  switch (name) {
    case "top":
      // Looking down. Screen up is e2, so the picture is a plan of the floor.
      return { right: e1, screenUp: e2, forward: neg(up), label: "PLAN, LOOKING DOWN" };
    case "front":
      return { right: e1, screenUp: up, forward: e2, label: "ELEVATION" };
    case "side":
      return { right: e2, screenUp: up, forward: neg(e1), label: "ELEVATION, TURNED 90" };
    case "floor":
      return { right: e1, screenUp: up, forward: e2, label: "ELEVATION, FLOOR BAND" };
    case "iso": {
      const forward = normalize([
        -(e1[0] + e2[0]) * 0.7 - up[0],
        -(e1[1] + e2[1]) * 0.7 - up[1],
        -(e1[2] + e2[2]) * 0.7 - up[2],
      ]);
      const right = normalize(cross(forward, up)) ?? e1;
      const screenUp = normalize(cross(right, forward)) ?? up;
      return { right, screenUp, forward, label: "THREE QUARTER" };
    }
    default:
      throw new Error(`unknown view "${name}" — one of ${VIEWS.join(", ")}`);
  }
}

const neg = (v) => [-v[0], -v[1], -v[2]];

/**
 * Project a cloud into an image.
 *
 * `heights` (metres above the fitted plane, one per point) is what every evidence-carrying colour
 * mode needs, and null when no plane could be fitted — in which case the picture says so rather
 * than falling back to something that looks like a valid reading.
 */
export function renderCloud(options) {
  const {
    points,
    colors = null,
    heights = null,
    selection = null,
    view,
    colour = "rgb",
    width = 900,
    height = 900,
    title = "",
    subtitle = "",
    turbo,
    heightRange = null,
    inlierDistance = 0.035,
    cameraTrack = null,
    floorBand = null,
    stride = 1,
    overlays = [],
  } = options;

  const image = canvas(width, height);
  const plot = {
    x: MARGIN.left,
    y: MARGIN.top,
    w: width - MARGIN.left - MARGIN.right,
    h: height - MARGIN.top - MARGIN.bottom,
  };

  const count = points.length / 3;
  const { right, screenUp, forward } = view;

  // Extent first, so the framing is a property of the data and nothing else.
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  const u = new Float64Array(count);
  const v = new Float64Array(count);
  const w = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      w[i] = NaN;
      continue;
    }
    const pu = x * right[0] + y * right[1] + z * right[2];
    const pv = x * screenUp[0] + y * screenUp[1] + z * screenUp[2];
    u[i] = pu;
    v[i] = pv;
    w[i] = x * forward[0] + y * forward[1] + z * forward[2];
    if (pu < minU) minU = pu;
    if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv;
    if (pv > maxV) maxV = pv;
  }

  if (!Number.isFinite(minU)) throw new Error("cloud has no finite points");

  // The floor band view crops to a slice around the FITTED PLANE and stretches it vertically.
  // Centring on the cloud's own mid-height instead — which is what this did first — lands the
  // crop halfway up the walls and shows no floor at all. The plane's screen position comes from
  // the points themselves: v minus height above the plane is the plane, for any point.
  let vLow = minV;
  let vHigh = maxV;
  let planeV = null;
  if (floorBand && heights) {
    for (let i = 0; i < count; i++) {
      if (Number.isFinite(w[i]) && Number.isFinite(heights[i])) {
        planeV = v[i] - heights[i];
        break;
      }
    }
    if (planeV !== null) {
      vLow = planeV + floorBand[0];
      vHigh = planeV + floorBand[1];
    }
  }

  const banded = planeV !== null;
  const scaleU = plot.w / Math.max(1e-9, maxU - minU);
  const scaleV = plot.h / Math.max(1e-9, vHigh - vLow);
  const scale = banded ? null : Math.min(scaleU, scaleV);
  const sx = scale ?? scaleU;
  const sy = scale ?? scaleV;
  const exaggeration = sy / sx;
  const originX = plot.x + (plot.w - (maxU - minU) * sx) / 2;
  const originY = plot.y + plot.h - (plot.h - (vHigh - vLow) * sy) / 2;

  const toX = (value) => Math.round(originX + (value - minU) * sx);
  const toY = (value) => Math.round(originY - (value - vLow) * sy);

  // Painter's algorithm with a depth buffer, so a near surface hides the far one. Without it a
  // plan view of a room shows the ceiling and the floor mixed together in the order they happen
  // to be stored, which reads as noise.
  const depth = new Float64Array(plot.w * plot.h).fill(Infinity);
  const cell = (px, py) => (py - plot.y) * plot.w + (px - plot.x);

  let drawn = 0;
  let selected = 0;

  for (let i = 0; i < count; i += stride) {
    if (!Number.isFinite(w[i])) continue;
    const px = toX(u[i]);
    const py = toY(v[i]);
    if (px < plot.x || py < plot.y || px >= plot.x + plot.w || py >= plot.y + plot.h) continue;

    const isSelected = selection ? selection[i] === 1 : false;
    // A selection is the answer to a question, so it wins the depth test outright. Otherwise a
    // sparse set of chosen points would be hidden behind the surface it was chosen from.
    const z = isSelected ? -Infinity : w[i];
    const at = cell(px, py);
    if (z > depth[at]) continue;
    depth[at] = z;

    setPixel(image, px, py, pointColour(i));
    drawn += 1;
    if (isSelected) {
      selected += 1;
      // Two pixels wide, because a hundred selected points among a million are otherwise a
      // rounding error on screen — and "is my selection actually on the thing" is the question.
      setPixel(image, px + 1, py, SELECT_RGB);
      setPixel(image, px, py + 1, SELECT_RGB);
    }
  }

  const projectWorld = (point) => ({
    x: toX(point[0] * right[0] + point[1] * right[1] + point[2] * right[2]),
    y: toY(point[0] * screenUp[0] + point[1] * screenUp[1] + point[2] * screenUp[2]),
  });
  for (const overlay of overlays) {
    const from = projectWorld(overlay.from);
    const to = projectWorld(overlay.to);
    line(image, from.x, from.y, to.x, to.y, overlay.rgb ?? [232, 169, 91]);
    for (const point of [from, to]) {
      fillRect(image, point.x - 3, point.y - 3, 7, 7, overlay.rgb ?? [232, 169, 91]);
    }
  }

  function pointColour(i) {
    if (selection && selection[i] === 1) return SELECT_RGB;
    if (colour === "rgb" && colors) {
      const at = i * 4;
      return [colors[at], colors[at + 1], colors[at + 2]];
    }
    if (colour === "height" && heights) {
      const [low, high] = heightRange;
      const t = (heights[i] - low) / Math.max(1e-9, high - low);
      const [r, g, b] = turbo(Math.min(1, Math.max(0, t)));
      return [r, g, b];
    }
    if (colour === "inlier" && heights) {
      const h = heights[i];
      if (h < -inlierDistance) return [235, 64, 52]; // below the plane: the failure signature
      if (h <= inlierDistance) return [250, 200, 60]; // the plane's own support
      return [96, 104, 128];
    }
    if (selection) return [58, 58, 66]; // context behind a selection, deliberately quiet
    return [170, 174, 186];
  }

  if (cameraTrack && cameraTrack.length >= 6) {
    for (let i = 0; i < cameraTrack.length / 3 - 1; i++) {
      const a = trackPoint(cameraTrack, i);
      const b = trackPoint(cameraTrack, i + 1);
      line(image, toX(a.u), toY(a.v), toX(b.u), toY(b.v), CAMERA_RGB);
    }
    const first = trackPoint(cameraTrack, 0);
    fillRect(image, toX(first.u) - 2, toY(first.v) - 2, 5, 5, CAMERA_RGB);
  }

  function trackPoint(track, i) {
    const x = track[i * 3];
    const y = track[i * 3 + 1];
    const z = track[i * 3 + 2];
    return {
      u: x * right[0] + y * right[1] + z * right[2],
      v: x * screenUp[0] + y * screenUp[1] + z * screenUp[2],
    };
  }

  // Where the fitted floor cuts this view. Only meaningful side-on: in plan it is the whole
  // picture, and drawing it would say nothing.
  if (heights && view.label.startsWith("ELEVATION")) {
    drawPlaneLine(image, plot, points, heights, { toX, toY }, u, v, count);
  }

  strokeRect(image, plot.x - 1, plot.y - 1, plot.w + 2, plot.h + 2, [40, 40, 48]);
  text(image, MARGIN.left, 8, title.slice(0, 70), INK);
  const heading = banded
    ? `${view.label} ${format(floorBand[0])}..${format(floorBand[1])}M, ${exaggeration.toFixed(1)}X VERTICAL`
    : view.label;
  text(image, width - MARGIN.right - textWidth(heading), 8, heading, DIM);

  drawScaleBar(image, plot, sx, sy, banded);
  if (colour === "height" && heights) drawHeightLegend(image, plot, heightRange, turbo);
  if (colour === "inlier" && heights) drawInlierLegend(image, plot, inlierDistance);

  const footer = [subtitle, `${drawn.toLocaleString("en-GB")} PTS DRAWN`]
    .filter(Boolean)
    .join("   ");
  text(image, MARGIN.left, height - 14, footer.slice(0, 90), DIM);

  return { image, drawn, selected, bounds: { minU, maxU, minV, maxV } };
}

/**
 * The fitted plane, drawn as the line of points closest to it in this projection.
 *
 * Sampling the cloud's own near-plane points rather than intersecting the plane with the view
 * frustum, because the second needs the plane's equation in view space and the first is already
 * in hand — and it has the useful property of stopping where the cloud stops, so the line never
 * claims floor where none was reconstructed.
 */
function drawPlaneLine(image, plot, points, heights, { toX, toY }, u, v, count) {
  const columns = new Map();
  const band = 0.02;
  for (let i = 0; i < count; i += 7) {
    if (Math.abs(heights[i]) > band) continue;
    const px = toX(u[i]);
    if (px < plot.x || px >= plot.x + plot.w) continue;
    const py = toY(v[i]);
    const current = columns.get(px);
    if (current === undefined) columns.set(px, py);
    else columns.set(px, (current + py) / 2);
  }
  for (const [px, py] of columns) setPixel(image, px, Math.round(py), [250, 230, 120]);
}

function drawScaleBar(image, plot, sx, sy, showVertical) {
  const metres = niceStep(plot.w / sx / 4);
  const pixels = Math.round(metres * sx);
  const y = plot.y + plot.h + 12;
  fillRect(image, plot.x, y, pixels, 2, INK);
  fillRect(image, plot.x, y - 3, 1, 8, INK);
  fillRect(image, plot.x + pixels - 1, y - 3, 1, 8, INK);
  text(image, plot.x + pixels + 6, y - 3, `${format(metres)} M`, INK);

  if (showVertical) {
    const vMetres = niceStep(plot.h / sy / 4);
    const vPixels = Math.round(vMetres * sy);
    fillRect(image, plot.x - 14, plot.y + plot.h - vPixels, 2, vPixels, INK);
    text(image, 4, plot.y + plot.h - vPixels - 9, `${format(vMetres)}M`, INK);
  }
}

function drawHeightLegend(image, plot, [low, high], turbo) {
  const barHeight = Math.min(180, plot.h - 20);
  const x = plot.x + plot.w - 16;
  const y = plot.y + 10;
  for (let i = 0; i < barHeight; i++) {
    const t = 1 - i / (barHeight - 1);
    const [r, g, b] = turbo(t);
    fillRect(image, x, y + i, 10, 1, [r, g, b]);
  }
  strokeRect(image, x - 1, y - 1, 12, barHeight + 2, [60, 60, 70]);
  badge(image, x - textWidth(`${format(high)}M`) - 6, y, `${format(high)}M`, INK);
  badge(image, x - textWidth(`${format(low)}M`) - 6, y + barHeight - 7, `${format(low)}M`, INK);
  badge(image, x - textWidth("ABOVE FLOOR") - 6, y + barHeight / 2 - 3, "ABOVE FLOOR", DIM);
}

function drawInlierLegend(image, plot, inlierDistance) {
  const rows = [
    [[250, 200, 60], `ON PLANE +-${format(inlierDistance)}M`],
    [[96, 104, 128], "ABOVE"],
    [[235, 64, 52], "BELOW"],
  ];
  let y = plot.y + 8;
  for (const [rgb, caption] of rows) {
    fillRect(image, plot.x + plot.w - 130, y, 8, 8, rgb);
    badge(image, plot.x + plot.w - 118, y + 1, caption, DIM);
    y += 13;
  }
}

function niceStep(raw) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1e-6, raw)));
  for (const step of [1, 2, 5, 10]) {
    if (raw <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

function format(value) {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 3;
  const fixed = value.toFixed(digits);
  return digits === 0 ? fixed : fixed.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * A grid of source frames, numbered.
 *
 * This is the picture of what the model was actually given, and it answers a class of question
 * the reconstruction cannot: whether the clip moved through the scene, whether it is the clip
 * anyone thinks it is, whether half of it is a shot of the floor. Frames are labelled with their
 * own file number because this repository has already been bitten by two numbering conventions.
 */
export function contactSheet(tiles, { columns, title, subtitle }) {
  const cellWidth = tiles[0].image.width;
  const cellHeight = tiles[0].image.height;
  const rows = Math.ceil(tiles.length / columns);
  const gap = 3;
  const top = 22;
  const bottom = 20;

  const image = canvas(
    columns * cellWidth + (columns + 1) * gap,
    top + rows * (cellHeight + gap) + gap + bottom,
  );

  tiles.forEach((tile, i) => {
    const x = gap + (i % columns) * (cellWidth + gap);
    const y = top + gap + Math.floor(i / columns) * (cellHeight + gap);
    blit(image, tile.image, x, y);
    badge(image, x + 2, y + 2, tile.label, INK);
  });

  text(image, gap, 7, title.slice(0, 100), INK);
  text(image, gap, image.height - 12, subtitle.slice(0, 120), DIM);
  return image;
}

/**
 * One frame's depth, colour-mapped exactly as Depth 2D maps it.
 *
 * The colour map is imported from the app rather than reproduced, so a depth picture printed here
 * and a depth pane on screen cannot disagree about what a colour means.
 */
export function depthImage(values, width, height, { turbo, low, high, title, subtitle, confidence }) {
  const scale = Math.max(1, Math.round(560 / Math.max(width, height)));
  const top = 22;
  const bottom = 34;
  const image = canvas(width * scale, top + height * scale + bottom);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = values[y * width + x];
      let rgb;
      if (!Number.isFinite(value)) {
        rgb = [90, 0, 90]; // a hole, and it should look like nothing else
      } else {
        const t = Math.min(1, Math.max(0, (value - low) / Math.max(1e-9, high - low)));
        const [r, g, b] = turbo(t);
        rgb = [r, g, b];
        if (confidence) {
          const c = Math.min(1, Math.max(0, confidence[y * width + x]));
          rgb = [rgb[0] * c, rgb[1] * c, rgb[2] * c].map(Math.round);
        }
      }
      fillRect(image, x * scale, top + y * scale, scale, scale, rgb);
    }
  }

  text(image, 4, 7, title.slice(0, 90), INK);
  const barWidth = Math.min(220, image.width - 90);
  const barY = image.height - 22;
  for (let i = 0; i < barWidth; i++) {
    const [r, g, b] = turbo(i / (barWidth - 1));
    fillRect(image, 4 + i, barY, 1, 8, [r, g, b]);
  }
  text(image, 4, barY + 11, `${format(low)}M`, DIM);
  text(image, 4 + barWidth - textWidth(`${format(high)}M`), barY + 11, `${format(high)}M`, DIM);
  text(image, 4 + barWidth + 10, barY, subtitle.slice(0, 40), DIM);
  return image;
}

/**
 * Selected points drawn on top of the photograph they came from.
 *
 * This is the check that no amount of numeric output can stand in for. A height statistic over a
 * patch of ground is only a measurement of grass if the patch is grass — and the only way to know
 * that is to see the chosen points lying on the actual pixels of the actual frame.
 */
export function frameOverlay(photo, marks, { title, subtitle, hit, total }) {
  const top = 22;
  const bottom = 20;
  const image = canvas(photo.width, top + photo.height + bottom);
  blit(image, photo, 0, top);

  for (const [x, y] of marks) {
    const px = Math.round(x);
    const py = Math.round(y) + top;
    setPixel(image, px, py, SELECT_RGB);
    setPixel(image, px + 1, py, SELECT_RGB);
    setPixel(image, px, py + 1, SELECT_RGB);
    setPixel(image, px + 1, py + 1, SELECT_RGB);
  }

  text(image, 4, 7, title.slice(0, 90), INK);
  text(
    image,
    4,
    image.height - 13,
    `${hit.toLocaleString("en-GB")} OF ${total.toLocaleString("en-GB")} SELECTED POINTS LAND IN THIS FRAME   ${subtitle}`.slice(0, 110),
    DIM,
  );
  return image;
}

/**
 * Tint regions of a photograph from masks at the reconstruction's own resolution.
 *
 * Sibling of `frameOverlay`, which draws scattered marks because a selection IS scattered.
 * Absence is not: the question "what part of this picture never reached the cloud" has a
 * region for an answer, and a region drawn as dots reads as sparse sampling — the exact
 * confusion this command exists to settle.
 *
 * `layers` are drawn in order, each `{ mask, rgb, label }` at `width`×`height`, so a later
 * layer wins where two overlap. Tinting blends rather than replaces, because the point is
 * to see WHICH part of the photograph is missing, not to paint over it.
 */
export function maskOverlay(photo, layers, { width, height, title, subtitle }) {
  const top = 22;
  const bottom = 20;
  const image = canvas(photo.width, top + photo.height + bottom);
  blit(image, photo, 0, top);

  for (const { mask, rgb } of layers) {
    for (let py = 0; py < photo.height; py++) {
      const sy = Math.min(height - 1, Math.floor((py * height) / photo.height));
      for (let px = 0; px < photo.width; px++) {
        const sx = Math.min(width - 1, Math.floor((px * width) / photo.width));
        if (!mask[sy * width + sx]) continue;
        const at = ((py + top) * image.width + px) * 3;
        image.data[at] = Math.round(image.data[at] * 0.35 + rgb[0] * 0.65);
        image.data[at + 1] = Math.round(image.data[at + 1] * 0.35 + rgb[1] * 0.65);
        image.data[at + 2] = Math.round(image.data[at + 2] * 0.35 + rgb[2] * 0.65);
      }
    }
  }

  let x = 6;
  const legendY = top + 6;
  for (const { rgb, label } of layers) {
    fillRect(image, x, legendY, 8, 8, rgb);
    badge(image, x + 12, legendY + 1, label, INK);
    x += 18 + textWidth(label);
  }

  text(image, 4, 7, title.slice(0, 100), INK);
  text(image, 4, image.height - 13, subtitle.slice(0, 120), DIM);
  return image;
}

/** Invert a row-major 4×4. Needed to send display-space points back to the cameras' own frame. */
export function invert4x4(m) {
  const a = [
    [m[0], m[1], m[2], m[3], 1, 0, 0, 0],
    [m[4], m[5], m[6], m[7], 0, 1, 0, 0],
    [m[8], m[9], m[10], m[11], 0, 0, 1, 0],
    [m[12], m[13], m[14], m[15], 0, 0, 0, 1],
  ];

  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-12) throw new Error("scene alignment is not invertible");
    [a[column], a[pivot]] = [a[pivot], a[column]];

    const divisor = a[column][column];
    for (let k = 0; k < 8; k++) a[column][k] /= divisor;

    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const factor = a[row][column];
      if (factor === 0) continue;
      for (let k = 0; k < 8; k++) a[row][k] -= factor * a[column][k];
    }
  }

  return a.flatMap((row) => row.slice(4));
}

/** Apply a row-major 4×4 to a point. */
export function apply4x4(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/**
 * World point (DA3's raw frame) to a pixel in frame `i`, or null when it is behind the camera.
 *
 * The forward direction of `backprojectMask`: camera space is `R·p + t` with the extrinsics row
 * major, and the pixel follows from the pinhole intrinsics. Keeping the two in one repository and
 * one convention is the whole reason this is written out rather than guessed.
 */
export function projectToPixel(point, extrinsics, intrinsics, offset) {
  const e = extrinsics;
  const b = offset * 12;
  const k = offset * 9;

  const cx = e[b] * point[0] + e[b + 1] * point[1] + e[b + 2] * point[2] + e[b + 3];
  const cy = e[b + 4] * point[0] + e[b + 5] * point[1] + e[b + 6] * point[2] + e[b + 7];
  const cz = e[b + 8] * point[0] + e[b + 9] * point[1] + e[b + 10] * point[2] + e[b + 11];
  if (!(cz > 1e-6)) return null;

  return [
    (intrinsics[k] * cx) / cz + intrinsics[k + 2],
    (intrinsics[k + 4] * cy) / cz + intrinsics[k + 5],
    cz,
  ];
}
