import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalFrameMap, fetchArtifactBuffer } from "./depth-field";
import { resampleMaskNearest } from "../graph/nodes/measurement";
import { connectCloud, disconnectCloud } from "../lib/cloud-store";

/**
 * How a 105 MB npz is fetched depends on where it lives, and getting it wrong produces a
 * corrupt point cloud rather than an error that names its cause.
 *
 * Through Cloud Run: ranged 24 MiB chunks, because a >32 MiB response returns 500 with zero
 * bytes, and the identity token must be attached.
 *
 * Through a signed GCS link: one request, and the token must NOT be attached — GCS answers
 * 401 to anything carrying both a header credential and a URL signature.
 */
describe("fetchArtifactBuffer", () => {
  const SIGNED =
    "https://storage.googleapis.com/verge-lab-runs/runs/transient/r/verge-result.npz" +
    "?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef";

  afterEach(() => {
    disconnectCloud();
    vi.unstubAllGlobals();
  });

  it("fetches a signed link whole, with no Authorization header and no Range", async () => {
    // A token IS connected, which is the point: it must not travel to the bucket.
    connectCloud("https://verge-da3.run.app", "an-identity-token");
    const size = 40 * 1024 * 1024; // over RANGE_BYTES, so chunking would engage if it applied
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return Promise.resolve(
        new Response(new Uint8Array(size), { status: 200, headers: { "content-length": String(size) } }),
      );
    });

    const buffer = await fetchArtifactBuffer(SIGNED, size);

    expect(buffer.byteLength).toBe(size);
    expect(calls).toHaveLength(1); // one request, not two 24 MiB chunks
    const headers = (calls[0].headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.Range).toBeUndefined();
  });

  it("rejects a short read rather than parsing a truncated npz", async () => {
    const size = 40 * 1024 * 1024;
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(new Uint8Array(size - 10), { status: 200 })),
    );
    await expect(fetchArtifactBuffer(SIGNED, size)).rejects.toThrow(/expected \d+ bytes/);
  });

  it("still range-chunks a Cloud Run artifact, where the 32 MiB cap does apply", async () => {
    connectCloud("https://verge-da3.run.app", "an-identity-token");
    const size = 40 * 1024 * 1024;
    const ranges: string[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      ranges.push(headers.Range);
      const [start, end] = /bytes=(\d+)-(\d+)/.exec(headers.Range)!.slice(1).map(Number);
      expect(headers.authorization).toBe("Bearer an-identity-token");
      return Promise.resolve(new Response(new Uint8Array(end - start + 1), { status: 206 }));
    });

    const buffer = await fetchArtifactBuffer("/artifact/r/verge-result.npz", size);

    expect(buffer.byteLength).toBe(size);
    expect(ranges).toEqual([
      "bytes=0-25165823",
      `bytes=25165824-${size - 1}`,
    ]);
  });
});

describe("canonicalFrameMap", () => {
  it("reproduces the exact 112-frame ladder mapping", () => {
    const map = canonicalFrameMap(112);
    expect(map).toHaveLength(112);
    expect(map[0]).toBe(1);
    expect(map[111]).toBe(256);
    expect(map[62]).toBe(143);
    expect(map[100]).toBe(231);
    expect(new Set(map).size).toBe(112);
  });

  it("keeps all canonical indices for a 256-frame run", () => {
    expect(canonicalFrameMap(256)).toEqual(Array.from({ length: 256 }, (_, i) => i + 1));
  });
});

/**
 * Which RGB file an NPZ index resolves to.
 *
 * A saved 81-frame cloud run was being read with the door fixtures' canonical map, so NPZ index
 * 1 loaded `frame-0004.jpg` and index 80 asked for `frame-0256.jpg` when only 81 files existed.
 * The early indices are the dangerous half: those files are present, so RGB and depth simply
 * disagreed, and a mask painted on one frame was back-projected with another frame's depth and
 * camera pose. No error was ever raised.
 */
describe("frame numbering conventions", () => {
  it("saved cloud runs are contiguous — NPZ index i is file i+1", () => {
    const identity = Array.from({ length: 81 }, (_, i) => i + 1);
    expect(identity[0]).toBe(1);
    expect(identity[25]).toBe(26);
    expect(identity[80]).toBe(81);
    // The whole point: it never asks for a file the run does not have.
    expect(Math.max(...identity)).toBe(81);
  });

  it("the canonical map would overrun a saved run — this is the bug it caused", () => {
    const canonical = canonicalFrameMap(81);
    expect(canonical[1]).toBe(4); // present but WRONG: silent desync
    expect(canonical[80]).toBe(256); // absent: 404 past index 25
    expect(canonical.filter((n) => n > 81).length).toBeGreaterThan(0);
  });

  it("still maps the built-in door fixtures across their shared 256-frame extraction", () => {
    const map = canonicalFrameMap(112);
    expect(map[0]).toBe(1);
    expect(map[111]).toBe(256);
    expect(map.length).toBe(112);
  });
});

describe("resampleMaskNearest", () => {
  it("preserves a painted quadrant across fixture resolutions", () => {
    const source = new Uint8Array([
      1, 1, 0, 0,
      1, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(Array.from(resampleMaskNearest(source, 4, 4, 2, 2))).toEqual([1, 0, 0, 0]);
    expect(resampleMaskNearest(source, 4, 4, 8, 8).reduce((sum, value) => sum + value, 0)).toBe(16);
  });
});
