// A pixel buffer, a bitmap font, and ffmpeg as the codec.
//
// Everything the inspector draws is drawn here, by hand, into a flat RGB array. That sounds like
// the long way round until you consider the alternatives: a headless browser to screenshot the
// real viewport (slow, and the picture then depends on WebGL, the window size and where a drag
// landed), or an image library (a dependency, for something this small).
//
// Drawing it directly buys the property that matters for evidence: the SAME cloud produces the
// SAME bytes, so two images from two commits differ only where the geometry differs.
//
// Encoding is ffmpeg's job. It is already a hard requirement of this project — `extract-frames`
// refuses to run without it — so using it as the PNG encoder and the JPEG decoder adds nothing.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const BACKGROUND = [13, 13, 15]; // matches the app's own surface, per DESIGN.md
export const INK = [222, 222, 228];
export const DIM = [120, 120, 130];

/** A flat RGB canvas. Origin top-left, as every image format expects. */
export function canvas(width, height, fill = BACKGROUND) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
  }
  return { width, height, data };
}

export function setPixel(image, x, y, rgb) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const at = (y * image.width + x) * 3;
  image.data[at] = rgb[0];
  image.data[at + 1] = rgb[1];
  image.data[at + 2] = rgb[2];
}

export function fillRect(image, x, y, w, h, rgb) {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) setPixel(image, x + dx, y + dy, rgb);
}

export function strokeRect(image, x, y, w, h, rgb) {
  for (let dx = 0; dx < w; dx++) {
    setPixel(image, x + dx, y, rgb);
    setPixel(image, x + dx, y + h - 1, rgb);
  }
  for (let dy = 0; dy < h; dy++) {
    setPixel(image, x, y + dy, rgb);
    setPixel(image, x + w - 1, y + dy, rgb);
  }
}

export function line(image, x0, y0, x1, y1, rgb) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let error = dx + dy;

  for (let guard = 0; guard < 8192; guard++) {
    setPixel(image, x, y, rgb);
    if (x === ex && y === ey) return;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
}

/** Paste one image into another, top-left at (x, y). */
export function blit(target, source, x, y) {
  for (let sy = 0; sy < source.height; sy++) {
    const ty = y + sy;
    if (ty < 0 || ty >= target.height) continue;
    for (let sx = 0; sx < source.width; sx++) {
      const tx = x + sx;
      if (tx < 0 || tx >= target.width) continue;
      const from = (sy * source.width + sx) * 3;
      const to = (ty * target.width + tx) * 3;
      target.data[to] = source.data[from];
      target.data[to + 1] = source.data[from + 1];
      target.data[to + 2] = source.data[from + 2];
    }
  }
}

// A 5×7 bitmap font, one 5-bit row per byte, most significant bit leftmost.
//
// Hand-written rather than rendered with ffmpeg's `drawtext`, which needs a freetype build that
// not every ffmpeg has. A picture whose scale bar renders on one machine and not another is
// worse than no scale bar, because only one of the two people can tell.
const GLYPHS = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ",": [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  "-": [0, 0, 0, 0x1f, 0, 0, 0],
  "+": [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  ":": [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  "/": [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  "%": [0x19, 0x1a, 0x02, 0x04, 0x08, 0x0b, 0x13],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "[": [0x0e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0e],
  "]": [0x0e, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0e],
  "=": [0, 0, 0x1f, 0, 0x1f, 0, 0],
  "<": [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  ">": [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
  "#": [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
  "*": [0, 0x0a, 0x04, 0x1f, 0x04, 0x0a, 0],
  _: [0, 0, 0, 0, 0, 0, 0x1f],
  "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0, 0x04],
  "!": [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04],
  "~": [0, 0, 0x08, 0x15, 0x02, 0, 0],
};

const UNKNOWN = [0x1f, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1f];

export const CHAR_WIDTH = 6; // 5 columns plus one of tracking

/** Width in pixels of `text` at `scale`, after the same folding `text()` applies. */
export function textWidth(value, scale = 1) {
  return ascii(value).length * CHAR_WIDTH * scale;
}

// Punctuation this project actually writes, folded to what the font has. Error messages from
// `geometry/` are drawn straight onto these pictures and they contain em dashes, degree signs and
// multiplication signs; without this every one of them becomes an unreadable box.
const TRANSLITERATE = new Map(Object.entries({
  "—": "-", "–": "-", "·": "-", "•": "-",
  "’": "'", "‘": "'", "“": '"', "”": '"',
  "°": " DEG", "×": "X", "±": "+-", "≥": ">=", "≤": "<=", "→": "->", "▲": "!",
}));

const ascii = (value) =>
  String(value).replace(/[^\x20-\x7e]/g, (character) => TRANSLITERATE.get(character) ?? "?");

/** Draw uppercase text. Lower case is folded up; this font has one case on purpose. */
export function text(image, x, y, value, rgb = INK, scale = 1) {
  let cursor = x;
  for (const character of ascii(value).toUpperCase()) {
    const glyph = GLYPHS[character] ?? UNKNOWN;
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 5; column++) {
        if (!(glyph[row] & (1 << (4 - column)))) continue;
        fillRect(image, cursor + column * scale, y + row * scale, scale, scale, rgb);
      }
    }
    cursor += CHAR_WIDTH * scale;
  }
  return cursor;
}

/** Text with a solid backing, for labels that land on top of a picture. */
export function badge(image, x, y, value, rgb = INK, scale = 1) {
  fillRect(image, x - 2, y - 2, textWidth(value, scale) + 3, 7 * scale + 4, [0, 0, 0]);
  text(image, x, y, value, rgb, scale);
}

/**
 * Write the canvas as a PNG.
 *
 * Raw RGB on stdin, so nothing has to agree about a temporary file's format. `-frames:v 1`
 * because rawvideo has no length of its own and ffmpeg would otherwise keep reading.
 */
export async function writePng(image, path) {
  mkdirSync(dirname(path), { recursive: true });
  await run(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "rgb24",
      "-s", `${image.width}x${image.height}`,
      "-i", "pipe:0",
      "-frames:v", "1",
      path,
    ],
    image.data,
  );
  return path;
}

/** Decode any image ffmpeg can read into an RGB canvas, scaled to `width` if given. */
export async function readImage(path, width = null) {
  const size = await probeSize(path);
  const targetWidth = width ?? size.width;
  const targetHeight = Math.max(1, Math.round((size.height * targetWidth) / size.width));

  const filters = width ? ["-vf", `scale=${targetWidth}:${targetHeight}`] : [];
  const raw = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", path,
    ...filters,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);

  const expected = targetWidth * targetHeight * 3;
  if (raw.length < expected) throw new Error(`${path}: decoded ${raw.length} of ${expected} bytes`);
  return { width: targetWidth, height: targetHeight, data: new Uint8Array(raw.subarray(0, expected)) };
}

async function probeSize(path) {
  const out = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    path,
  ]);
  const [width, height] = out.toString().trim().split("x").map(Number);
  if (!(width > 0) || !(height > 0)) throw new Error(`${path}: could not read image size`);
  return { width, height };
}

function run(command, args, stdin = null) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) =>
      rejectRun(
        error.code === "ENOENT"
          ? new Error(`${command} not found on PATH — install ffmpeg with your platform package manager`)
          : error,
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolveRun(Buffer.concat(out))
        : rejectRun(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString().trim()}`)),
    );
    if (stdin) child.stdin.end(Buffer.from(stdin.buffer, stdin.byteOffset, stdin.byteLength));
    else child.stdin.end();
  });
}
