/**
 * The local cloud control plane.
 *
 * The parity test is the one that earns its keep. `cloudStatus` predicts whether a deploy will
 * skip the 15-20 min build by recomputing the tag `scripts/deploy.sh` derives from `server/`.
 * If the two ever disagree the UI says "build skipped" and the deploy spends twenty minutes —
 * a wrong answer that costs real time. So the reimplementation is pinned against the actual
 * shell pipeline, exactly as `cache-key.test.ts` pins the donor port.
 */

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { InferManifest } from "./contract";
import { manifestFromWire } from "./infer-client";
import {
  sourceTag,
  // @ts-expect-error - plain ESM module, no type declarations
} from "../../vite-plugins/cloud.mjs";
import {
  getJob,
  getRunningJob,
  redact,
  resetJobs,
  startJob,
  // @ts-expect-error - plain ESM module, no type declarations
} from "../../vite-plugins/jobs.mjs";
import {
  localApi,
  // @ts-expect-error - plain ESM module, no type declarations
} from "../../vite-plugins/local-api.mjs";
import {
  toWireManifest,
  // @ts-expect-error - plain ESM module, no type declarations
} from "../../vite-plugins/runs.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** The exact pipeline from scripts/deploy.sh, run for real. */
async function shellSourceTag(root: string): Promise<string> {
  const pipeline =
    "find server -type f -not -path '*/__pycache__/*' | LC_ALL=C sort " +
    "| xargs shasum -a 256 | shasum -a 256 | cut -c1-16";
  const { stdout } = await execFileAsync("bash", ["-c", `printf 'src-%s' "$(${pipeline})"`], {
    cwd: root,
  });
  return stdout.trim();
}

describe("sourceTag", () => {
  it("agrees with deploy.sh's own pipeline on the real server/ tree", async () => {
    expect(await sourceTag(REPO_ROOT)).toBe(await shellSourceTag(REPO_ROOT));
  });

  it("changes when any byte under server/ changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "verge-tag-"));
    try {
      await mkdir(join(root, "server/sub"), { recursive: true });
      await writeFile(join(root, "server/main.py"), "print(1)\n");
      await writeFile(join(root, "server/sub/util.py"), "x = 1\n");
      const before = await sourceTag(root);
      expect(before).toBe(await shellSourceTag(root));

      // A comment is enough. This is why server/ is frozen: one byte costs 20 minutes.
      await writeFile(join(root, "server/main.py"), "print(1)  # tweak\n");
      const after = await sourceTag(root);
      expect(after).not.toBe(before);
      expect(after).toBe(await shellSourceTag(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores __pycache__, which deploy.sh also excludes", async () => {
    const root = await mkdtemp(join(tmpdir(), "verge-tag-"));
    try {
      await mkdir(join(root, "server"), { recursive: true });
      await writeFile(join(root, "server/main.py"), "print(1)\n");
      const before = await sourceTag(root);

      await mkdir(join(root, "server/__pycache__"), { recursive: true });
      await writeFile(join(root, "server/__pycache__/main.pyc"), "compiled");
      expect(await sourceTag(root)).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("redact", () => {
  it("removes credential-shaped strings from job output", () => {
    expect(redact("token: ya29.a0AfB_byC-1234567890abcdef")).toContain("«redacted-token»");
    expect(
      redact("bearer eyJhbGciOiJSUzI1NiIsImtpZCI.eyJhdWQiOiJodHRwczovL3g.SflKxwRJSMeKKF2QT4f"),
    ).toContain("«redacted-jwt»");
  });

  it("leaves deploy.sh's literal export line alone", () => {
    const line = 'export VERGE_TOKEN="$(gcloud auth print-identity-token)"';
    expect(redact(line)).toBe(line);
  });
});

describe("job runner", () => {
  afterEach(() => resetJobs());

  it("captures output and reports success", async () => {
    const { job } = startJob({
      kind: "test",
      command: "bash",
      args: ["-c", "echo one; echo two >&2"],
    });
    const result = await waitFor(job.id);
    expect(result.status).toBe("succeeded");
    expect(result.lines).toContain("one");
    expect(result.lines).toContain("two");
  });

  it("reports a failing script rather than resolving quietly", async () => {
    const { job } = startJob({ kind: "test", command: "bash", args: ["-c", "echo bad; exit 3"] });
    const result = await waitFor(job.id);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("is single-flight per kind — a second start attaches, never spawns", async () => {
    const first = startJob({ kind: "deploy", command: "bash", args: ["-c", "sleep 0.4"] });
    const second = startJob({ kind: "deploy", command: "bash", args: ["-c", "sleep 0.4"] });
    expect(second.attached).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    await waitFor(first.job.id);
  });

  it("exposes the running job by kind, so a reloaded page can reattach", async () => {
    const { job } = startJob({ kind: "deploy", command: "bash", args: ["-c", "sleep 0.3"] });
    expect(getRunningJob("deploy")?.id).toBe(job.id);
    await waitFor(job.id);
    expect(getRunningJob("deploy")).toBeNull();
  });

  it("redacts before a line is ever readable", async () => {
    const { job } = startJob({
      kind: "test",
      command: "bash",
      args: ["-c", "echo ya29.a0AfB_byCsecretsecretsecret"],
    });
    const result = await waitFor(job.id);
    expect(result.lines.join("\n")).not.toContain("secretsecret");
  });
});

/**
 * Saving a real cloud run.
 *
 * This is a regression test with a receipt. On 2026-08-05 a paid 112-frame run was saved for
 * the first time and `save-run.sh` died on `KeyError: 'run_id'`: the registry stores the app's
 * camelCase manifest, the script parses the service's snake_case JSON, and nobody had noticed
 * because every previous Save was a built-in fixture that never reaches the script at all. The
 * artifacts were still on a billing instance at the time.
 */
describe("toWireManifest", () => {
  it("converts the stored manifest back into what save-run.sh parses", () => {
    const wire = toWireManifest({
      runId: "20260805-144554-780dbc",
      artifacts: [
        { kind: "glb", name: "scene.glb", sizeBytes: 16098484, sha256: "aa", url: "/artifact/x/scene.glb" },
        { kind: "npz", name: "verge-result.npz", sizeBytes: 107434959, sha256: "bb", url: "/artifact/x/n.npz" },
      ],
    });

    // The exact keys scripts/save-run.sh reads. Every one of these was missing before.
    expect(wire.run_id).toBe("20260805-144554-780dbc");
    expect(wire.artifacts[0]).toEqual({
      name: "scene.glb",
      sha256: "aa",
      url: "/artifact/x/scene.glb",
      kind: "glb",
      size_bytes: 16098484,
    });
    // Range chunking is driven off this number; undefined would fetch the whole 102 MiB in one
    // request and hit Cloud Run's 32 MiB response cap.
    expect(wire.artifacts[1].size_bytes).toBe(107434959);
  });

  it("survives a manifest with no artifacts rather than throwing mid-save", () => {
    expect(toWireManifest({ runId: "x" }).artifacts).toEqual([]);
  });

  /**
   * The test that would have caught the SECOND bug, which the first fix caused.
   *
   * save-run.sh copies this exact object into the run directory as `manifest.json`, and
   * `loadRunDepthField` reads it back through `manifestFromWire`. So the real contract is not
   * "has the keys the script parses" — it is "survives a round trip". A version emitting only
   * run_id and artifacts passed the field-by-field test above and still made every saved run
   * unloadable.
   */
  it("round-trips through manifestFromWire without losing anything the app reads", () => {
    const original: InferManifest = {
      schemaVersion: "verge.infer-manifest/0.1.0",
      runId: "20260805-151526-a99a78",
      modelRepositoryId: "depth-anything/DA3NESTED-GIANT-LARGE-1.1",
      modelRevision: "b2359bdf726fb44ef62acca04d629dcf158053e7",
      depthMode: "metric",
      linearUnit: "metre",
      params: {
        fps: 8.27,
        sourceDurationS: 13.55,
        processRes: 504,
        processResMethod: "upper_bound_resize",
        refViewStrategy: "middle",
        maxFrames: 112,
      },
      frames: { count: 81, requestedCount: 81, width: 1024, height: 576, capped: true, effectiveFps: 5.98 },
      timing: { gpuSeconds: 36.9, wallSeconds: 41.2, modelLoadSeconds: 40.1 },
      vram: {
        peakBytes: 23_648_000_000,
        currentBytes: 7_050_625_024,
        totalBytes: 23_659_151_360,
        deviceName: "NVIDIA L4",
        torchPeakBytes: 18_500_000_000,
        baselineBytes: 7_050_625_024,
      },
      artifacts: [
        { kind: "glb", name: "scene.glb", sizeBytes: 16071460, sha256: "c49d", url: "/artifact/x/scene.glb" },
      ],
      transient: true,
      expiresAfterDays: 3,
      mock: false,
    };

    const restored = manifestFromWire(toWireManifest(original));
    expect(restored).toEqual(original);

    // Named individually because these four are what actually threw: Run Source died on
    // `Cannot read properties of undefined`, and the viewport just kept the old point cloud.
    expect(restored.params.fps).toBe(8.27);
    expect(restored.frames.count).toBe(81);
    expect(restored.timing.gpuSeconds).toBe(36.9);
    expect(restored.vram.peakBytes).toBe(23_648_000_000);
  });
});

/**
 * The routes, driven directly.
 *
 * The job runner's own mechanics are covered above; what this covers is the seam between it
 * and HTTP — SSE framing, the late-attach replay, and the 404. Driving the real middleware
 * (rather than curling a dev server) keeps it offline: no gcloud, no network, no cloud action.
 */
describe("job routes", () => {
  afterEach(() => resetJobs());

  it("streams a snapshot, then lines, then an end event", async () => {
    const handler = middleware();
    const { job } = startJob({
      kind: "test",
      command: "bash",
      args: ["-c", "echo alpha; sleep 0.1; echo beta"],
    });

    const res = fakeResponse();
    await handler(fakeRequest(`/api/cloud/job/${job.id}?stream=1`), res, () => {});
    await waitFor(job.id);
    await new Promise((r) => setTimeout(r, 50));

    const events = res.body
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")));

    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(events[0].type).toBe("snapshot");
    const lines = events.filter((e) => e.type === "line").map((e) => e.line);
    const seen = [...events[0].job.lines, ...lines];
    expect(seen).toContain("alpha");
    expect(seen).toContain("beta");
    expect(events.at(-1)).toMatchObject({ type: "end", status: "succeeded" });
  });

  it("replays the whole buffer to a client that attaches after the job finished", async () => {
    const handler = middleware();
    const { job } = startJob({ kind: "test", command: "bash", args: ["-c", "echo only-line"] });
    await waitFor(job.id);

    const res = fakeResponse();
    await handler(fakeRequest(`/api/cloud/job/${job.id}?stream=1`), res, () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(res.body).toContain("only-line");
    expect(res.body).toContain('"type":"end"');
  });

  it("reports the running job by kind and 404s an unknown id", async () => {
    const handler = middleware();
    const { job } = startJob({ kind: "deploy", command: "bash", args: ["-c", "sleep 0.3"] });

    const byKind = fakeResponse();
    await handler(fakeRequest("/api/cloud/job?kind=deploy"), byKind, () => {});
    expect(JSON.parse(byKind.body).job.id).toBe(job.id);

    const missing = fakeResponse();
    await handler(fakeRequest("/api/cloud/job/nope"), missing, () => {});
    expect(missing.statusCode).toBe(404);

    await waitFor(job.id);
  });
});

/**
 * The authenticated reverse proxy, against a local stand-in service.
 *
 * The Range case is the one that matters. The app fetches anything over 24 MiB in ranges
 * because Cloud Run caps responses at 32 MiB, and `fetchArtifactBuffer` asserts the exact byte
 * count of every chunk — so a proxy that dropped `content-range` or collapsed 206 into 200
 * would not fail here, it would fail later as a corrupt point cloud.
 */
describe("service proxy", () => {
  let server: Server;
  let seen: { url: string; method: string; authorization?: string; body: string }[] = [];
  const payload = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          url: req.url!,
          method: req.method!,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });

        if (req.url === "/forbidden") {
          res.statusCode = 403;
          return res.end("denied by IAM");
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
        if (range) {
          const [start, end] = [Number(range[1]), Number(range[2])];
          res.statusCode = 206;
          res.setHeader("content-range", `bytes ${start}-${end}/${payload.length}`);
          res.setHeader("accept-ranges", "bytes");
          return res.end(payload.subarray(start, end + 1));
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.end(payload);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    process.env.VERGE_SERVICE_URL = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    delete process.env.VERGE_SERVICE_URL;
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    seen = [];
  });

  it("preserves 206 and content-range, which the npz chunking depends on", async () => {
    const handler = middleware();
    const req = fakeRequest("/api/cloud/svc/artifact/run/verge-result.npz");
    req.headers.range = "bytes=4-9";
    const res = fakeResponse();
    await handler(req, res, () => {});
    await new Promise((r) => setTimeout(r, 60));

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 4-9/${payload.length}`);
    expect(res.body).toBe("456789");
  });

  it("forwards the path and query to the service unchanged", async () => {
    const handler = middleware();
    await handler(fakeRequest("/api/cloud/svc/gpu?verbose=1"), fakeResponse(), () => {});
    await new Promise((r) => setTimeout(r, 60));
    expect(seen[0].url).toBe("/gpu?verbose=1");
  });

  it("never forwards an Authorization header supplied by the browser", async () => {
    const handler = middleware();
    const req = fakeRequest("/api/cloud/svc/gpu");
    // A page that tried to inject its own credential must not be able to.
    req.headers.authorization = "Bearer browser-supplied";
    await handler(req, fakeResponse(), () => {});
    await new Promise((r) => setTimeout(r, 60));
    expect(seen[0].authorization).toBeUndefined();
  });

  it("explains a 403 instead of leaking a bare status into a node error", async () => {
    const handler = middleware();
    const res = fakeResponse();
    await handler(fakeRequest("/api/cloud/svc/forbidden"), res, () => {});
    await new Promise((r) => setTimeout(r, 60));

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.detail).toContain("run.invoker");
    expect(body.upstream).toContain("denied by IAM");
  });
});

/** The plugin's request handler, pulled out of the Vite plugin shape. */
function middleware() {
  let handler: (req: unknown, res: unknown, next: () => void) => Promise<void>;
  localApi().configureServer({
    middlewares: { use: (fn: never) => (handler = fn) },
    httpServer: null,
  });
  return handler!;
}

function fakeRequest(url: string, method = "GET") {
  const req = new EventEmitter() as EventEmitter & {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  req.url = url;
  req.method = method;
  req.headers = {};
  return req;
}

/**
 * A real Writable, not a plain object with a `write` method.
 *
 * The proxy pipes the upstream body into the response, and the first version of this fake —
 * which only looked like a response — turned every piped reply into a 500 that the middleware
 * swallowed. A fake that cannot fail the way the real thing does proves nothing.
 */
function fakeResponse() {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  }) as Writable & {
    statusCode: number;
    headers: Record<string, string>;
    setHeader: (name: string, value: string) => void;
    readonly body: string;
  };
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  Object.defineProperty(res, "body", {
    get: () => Buffer.concat(chunks).toString("utf8"),
  });
  return res;
}

async function waitFor(id: string) {
  for (let i = 0; i < 200; i++) {
    const job = getJob(id);
    if (job && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job did not finish");
}
