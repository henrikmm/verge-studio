// The cloud control plane, local half.
//
// Everything here runs in the local Vite development process. None of it exists in a production
// build and none of it is reachable from anywhere but localhost — same standing as /api/upload
// and the old /api/teardown.
//
// Two jobs:
//
// 1. **Say what the world looks like before anything is spent** (`cloudStatus`). Is gcloud
//    installed and authenticated, does the service exist, and — the expensive question —
//    does Artifact Registry already hold an image for the current `server/` source? That last
//    one is the difference between a ~1-3 min deploy and a 15-20 min rebuild, and until now
//    the only way to learn the answer was to start the deploy and watch.
// 2. **Let the browser talk to an authenticated service without holding a credential**
//    (`proxyToService`). The token is minted here, cached here, and never serialized into a
//    response. The browser addresses a same-origin path; this process attaches the bearer.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { loadLocalCloudEnv } from "./local-env.mjs";

const execFileAsync = promisify(execFile);

loadLocalCloudEnv();

// Same defaults and same env overrides as scripts/deploy.sh, so the two cannot describe
// different services. If you change one, change both.
export const PROJECT_ID = (process.env.PROJECT_ID ?? "").trim();
export const REGION = process.env.REGION ?? "us-central1";
export const SERVICE = process.env.SERVICE ?? "verge-da3";
export const REPOSITORY = process.env.REPOSITORY ?? "verge";
export const IMAGE_NAME = process.env.IMAGE_NAME ?? "da3-service";
export const OUTPUT_BUCKET = (process.env.VERGE_OUTPUT_BUCKET ?? "").trim();
export const IMAGE_URI = PROJECT_ID ? `${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}` : "";

export function configurationError(env = { PROJECT_ID, VERGE_OUTPUT_BUCKET: OUTPUT_BUCKET }) {
  const missing = [!env.PROJECT_ID && "PROJECT_ID", !env.VERGE_OUTPUT_BUCKET && "VERGE_OUTPUT_BUCKET"].filter(Boolean);
  return missing.length ? `cloud is unconfigured: set ${missing.join(" and ")}` : null;
}

/* ------------------------------------------------------------------ source tag */

/**
 * Recompute the content-addressed image tag that `scripts/deploy.sh` builds from `server/`:
 *
 *   find server -type f -not -path '*​/__pycache__/*' | LC_ALL=C sort | xargs shasum -a 256 \
 *     | shasum -a 256 | cut -c1-16
 *
 * This is a reimplementation, not a shell-out, because it is called on every status refresh.
 * `cloud-control.test.ts` pins it against the real pipeline so the two can never drift — if
 * they did, the UI would predict "build skipped" and the deploy would spend 20 minutes.
 *
 * Byte-order sort, not locale sort: `LC_ALL=C` is what deploy.sh asks for, and JS string
 * comparison would order non-ASCII paths differently.
 */
export async function sourceTag(repoRoot) {
  const root = join(repoRoot, "server");
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") continue;
        await walk(full);
      } else if (entry.isFile()) {
        // `find -type f` follows neither symlinks nor sockets; isFile() on a Dirent is the
        // same predicate for our purposes because lstat drives it.
        files.push(full);
      }
    }
  }
  await walk(root);

  const relatives = files.map((full) => `server${sep}${relative(root, full)}`);
  relatives.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));

  // shasum -a 256 prints "<hex>  <path>\n" — two spaces, text mode.
  const digest = createHash("sha256");
  for (const rel of relatives) {
    const bytes = await readFile(join(repoRoot, rel));
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    digest.update(`${fileHash}  ${rel}\n`);
  }
  return `src-${digest.digest("hex").slice(0, 16)}`;
}

/* ------------------------------------------------------------------ status */

async function gcloud(args, timeout = 25_000) {
  try {
    const { stdout } = await execFileAsync("gcloud", args, { timeout });
    return { ok: true, out: stdout.trim(), error: null };
  } catch (err) {
    const message =
      err && typeof err === "object" && "code" in err && err.code === "ENOENT"
        ? "gcloud is not on PATH"
        : String((err && err.stderr) || (err && err.message) || err).trim();
    return { ok: false, out: "", error: message.slice(0, 400) };
  }
}

/**
 * Status is *slow* (three gcloud round trips, ~1-3 s) but free: none of these calls touch the
 * service, so none of them can wake an instance or extend its billed lifetime. The short cache
 * exists to absorb React's double-invoked effects in dev, not to hide staleness — the UI has an
 * explicit Refresh, and every reply carries `checkedAt`.
 */
let cached = null;
const CACHE_MS = 5_000;

export async function cloudStatus(repoRoot, { refresh = false } = {}) {
  if (!refresh && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;

  const configError = configurationError();
  if (configError) {
    cached = {
      checkedAt: Date.now(),
      configured: false,
      gcloud: { available: false, error: configError },
      auth: { active: false, account: null, hint: configError },
      project: "",
      region: REGION,
      service: { name: SERVICE, exists: false, url: null },
      image: { uri: "", tag: null, present: false },
      deploy: { willSkipBuild: false, estimate: "unconfigured", detail: configError },
    };
    return cached;
  }

  const version = await gcloud(["--version"], 15_000);
  if (!version.ok) {
    cached = {
      checkedAt: Date.now(),
      configured: true,
      gcloud: { available: false, error: version.error },
      auth: { active: false, account: null },
      project: PROJECT_ID,
      region: REGION,
      service: { name: SERVICE, exists: false, url: null },
      image: { uri: IMAGE_URI, tag: null, present: false },
      deploy: { willSkipBuild: false, estimate: "unknown — gcloud unavailable" },
    };
    return cached;
  }

  const tag = await sourceTag(repoRoot);
  const [account, service, image] = await Promise.all([
    gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]),
    gcloud([
      "run",
      "services",
      "describe",
      SERVICE,
      `--region=${REGION}`,
      `--project=${PROJECT_ID}`,
      "--format=value(status.url)",
    ]),
    // The exact predicate deploy.sh branches on. Same image URI, same tag, same command.
    gcloud(["artifacts", "docker", "images", "describe", `${IMAGE_URI}:${tag}`, `--project=${PROJECT_ID}`]),
  ]);

  const authed = account.ok && account.out.length > 0;
  const serviceUrl = service.ok && service.out.startsWith("http") ? service.out : null;

  cached = {
    checkedAt: Date.now(),
    configured: true,
    gcloud: { available: true, error: null },
    auth: {
      active: authed,
      account: authed ? account.out.split("\n")[0] : null,
      // The one failure no button can repair: it needs a browser consent screen.
      hint: authed ? null : "run `gcloud auth login` in a terminal",
    },
    project: PROJECT_ID,
    region: REGION,
    service: { name: SERVICE, exists: serviceUrl !== null, url: serviceUrl },
    image: { uri: IMAGE_URI, tag, present: image.ok },
    deploy: {
      willSkipBuild: image.ok,
      // Short enough to survive a narrow inspector row; the reason travels in `detail`.
      estimate: image.ok ? "~1-3 min · build skipped" : "~15-20 min · rebuild",
      detail: image.ok
        ? `Artifact Registry already holds ${IMAGE_NAME}:${tag}, so deploy.sh takes its build-skip branch and only rolls out a revision.`
        : `No image tagged ${tag} exists, so deploy.sh will run Cloud Build (~12 GB). Every file under server/ feeds that tag — even a comment changes it.`,
    },
  };
  return cached;
}

/** Drop the cache so the next status reflects a deploy or teardown that just finished. */
export function invalidateCloudStatus() {
  cached = null;
  serviceUrlCache = null;
}

/* ------------------------------------------------------------------ identity token */

let tokenCache = null;

function tokenExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * A Google identity token for the service, minted from the active gcloud CLI login.
 *
 * NEVER returned to the browser, never written to a log, never put in a URL. It exists inside
 * this process for exactly as long as it takes to attach an Authorization header.
 *
 * Cached until five minutes before expiry: tokens last about an hour, a warm session can
 * outlast one, and spawning gcloud costs ~300-600 ms — too slow to pay per request when the
 * app fetches a 108 MB npz in 24 MiB chunks.
 */
export async function identityToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60_000) return tokenCache.token;
  const result = await gcloud(["auth", "print-identity-token"], 30_000);
  if (!result.ok || !result.out) {
    throw new Error(`could not mint an identity token (${result.error ?? "empty output"})`);
  }
  const token = result.out.split("\n")[0].trim();
  tokenCache = { token, expiresAt: tokenExpiry(token) || Date.now() + 30 * 60_000 };
  return token;
}

/* ------------------------------------------------------------------ reverse proxy */

let serviceUrlCache = null;

/**
 * Where the service lives.
 *
 * `VERGE_SERVICE_URL` overrides the lookup, which covers running the DA3 container locally on
 * the local computer — a legitimate development path used by proxy tests with no cloud.
 */
async function resolveServiceUrl(repoRoot) {
  if (process.env.VERGE_SERVICE_URL) return approvedServiceUrl(process.env.VERGE_SERVICE_URL);
  if (serviceUrlCache) return serviceUrlCache;
  const status = await cloudStatus(repoRoot);
  if (!status.service.url) throw new Error(`no deployed service named ${SERVICE}`);
  serviceUrlCache = status.service.url;
  return serviceUrlCache;
}

/** A bearer minted here may only travel to Cloud Run or an explicit loopback test service. */
export function approvedServiceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("service URL is invalid");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !loopback) || (!loopback && !url.hostname.endsWith(".run.app"))) {
    throw new Error("refusing to send an identity token to an unapproved service host");
  }
  return url.toString().replace(/\/$/, "");
}

/** A service on this machine has no IAM in front of it, so there is no token to mint. */
function needsAuth(base) {
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);
}

// What travels upstream. An Authorization header from the browser is deliberately NOT in this
// list: the only credential that reaches the service is the one minted above.
const REQUEST_HEADERS = ["content-type", "content-length", "accept", "range"];

// What comes back. `content-range` and `accept-ranges` matter more than they look: the app
// fetches anything over 24 MiB in ranges because Cloud Run caps responses at 32 MiB, and it
// asserts exact byte counts. A proxy that collapsed 206 into 200 would surface as a corrupt
// point cloud rather than as a transport bug.
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];

/**
 * Forward one request to the deployed service, authenticated.
 *
 * Bodies stream in both directions: a 112-frame multipart upload is ~15 MB and a run's
 * artifacts are ~135 MB, neither of which should be buffered in the dev server's heap.
 */
export async function proxyToService(repoRoot, req, res, subPath) {
  const base = await resolveServiceUrl(repoRoot);
  const target = `${base}${subPath}`;

  const headers = needsAuth(base) ? { authorization: `Bearer ${await identityToken()}` } : {};
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    // Required by undici whenever the body is a stream.
    ...(hasBody ? { duplex: "half" } : {}),
    redirect: "manual",
  });

  res.statusCode = upstream.status;
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) res.setHeader(name, value);
  }

  if (upstream.status === 401 || upstream.status === 403) {
    // Worth naming precisely. The identity token is minted from a user account, whose
    // audience Cloud Run accepts for an invoker — but if the account lacks run.invoker, or
    // ADC has gone stale, this is where it shows up, and the message should say so rather
    // than surfacing as a bare 403 inside a node's error line.
    const detail = await upstream.text().catch(() => "");
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        detail:
          `${upstream.status} from ${SERVICE}. The identity token was rejected — check that ` +
          `this account holds roles/run.invoker, or re-run \`gcloud auth login\`.`,
        upstream: detail.slice(0, 300),
      }),
    );
  }

  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}
