/**
 * The manifest returns URLs that are relative to the INFERENCE SERVICE
 * (`/artifact/{run_id}/{name}`), not to the page. Fetched as-is from the browser they
 * resolve against the Vite dev origin and 404 — so every GLB and npz from a real cloud
 * run would fail to load, after the GPU had already been paid for.
 *
 * The mock's URLs (`/roadside/...`) ARE served by Vite and must be left untouched, so
 * rebasing has to be conditional on the service actually being remote.
 *
 * The base moved from a build-time env var to the runtime cloud session on 2026-08-04, so
 * these now drive `connectCloud`/`disconnectCloud`. The rebasing rules are unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";
import { connectCloud, disconnectCloud } from "./cloud-store";
import { artifactUrl, isSignedStorageUrl } from "./infer-client";

afterEach(() => {
  disconnectCloud();
});

describe("artifactUrl with a remote service", () => {
  const REMOTE = "https://verge-da3-abc123-uc.a.run.app";

  it("rebases a service-relative artifact path onto the service", () => {
    connectCloud(REMOTE, "");
    expect(artifactUrl("/artifact/20260801-1200-ab12/scene.glb")).toBe(
      `${REMOTE}/artifact/20260801-1200-ab12/scene.glb`,
    );
  });

  it("works through a localhost proxy, which is how auth is supplied", () => {
    connectCloud("http://localhost:8080", "");
    expect(artifactUrl("/artifact/run/verge-result.npz")).toBe(
      "http://localhost:8080/artifact/run/verge-result.npz",
    );
  });

  it("does not double up slashes when the base has a trailing one", () => {
    connectCloud(`${REMOTE}/`, "");
    expect(artifactUrl("/artifact/run/scene.glb")).toBe(`${REMOTE}/artifact/run/scene.glb`);
  });

  it("leaves an already-absolute URL alone", () => {
    connectCloud(REMOTE, "");
    const signed = "https://storage.googleapis.com/bucket/scene.glb?X-Goog-Signature=abc";
    expect(artifactUrl(signed)).toBe(signed);
  });

  it("fails loudly on a gs:// URL rather than producing an unfetchable string", () => {
    connectCloud(REMOTE, "");
    // A well-formed manifest never puts gs:// in `url` — that address belongs in `gsUri`,
    // and `url` carries the signed link. If the two are ever swapped, this says so instead
    // of silently building "https://…/gs://…" and producing a baffling 404.
    expect(() => artifactUrl("gs://bucket/runs/scene.glb")).toThrow(/gsUri/);
  });
});

/**
 * A signed link has to be fetched differently from a service path, and both differences
 * fail in ways that do not point at their cause.
 *
 * GCS treats a request carrying an `Authorization` header AND a URL signature as an
 * unauthenticated one — the header wins, the signature is ignored, and the answer is a 401
 * that looks like a credential problem. And the 32 MiB response cap belongs to Cloud Run,
 * not to the bucket, so range-chunking a signed link is pointless work that only adds ways
 * to be wrong.
 */
describe("isSignedStorageUrl", () => {
  it("recognises a signed GCS link", () => {
    expect(
      isSignedStorageUrl(
        "https://storage.googleapis.com/example-verge-runs/runs/transient/r/scene.glb" +
          "?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef",
      ),
    ).toBe(true);
  });

  it("rejects an unsigned storage URL, which the browser cannot read anyway", () => {
    // public-access-prevention is on, so this would 403. Treating it as signed would send
    // it without the token and lose the only credential that might have worked.
    expect(isSignedStorageUrl("https://storage.googleapis.com/example-verge-runs/x.glb")).toBe(false);
  });

  it("rejects a Cloud Run artifact URL, which DOES need the token and the range chunking", () => {
    expect(
      isSignedStorageUrl("https://verge-da3-abc123-uc.a.run.app/artifact/run/verge-result.npz"),
    ).toBe(false);
  });

  it("rejects a service-relative path", () => {
    expect(isSignedStorageUrl("/artifact/run/scene.glb")).toBe(false);
  });
});

describe("artifactUrl against the local mock", () => {
  it("leaves fixture URLs alone, because Vite really does serve them", () => {
    expect(artifactUrl("/roadside/scene.glb")).toBe("/roadside/scene.glb");
    expect(artifactUrl("/roadside/result.npz")).toBe("/roadside/result.npz");
  });

  it("stays local after a disconnect, so a stale base cannot outlive the session", () => {
    connectCloud("https://verge-da3.run.app", "");
    disconnectCloud();
    expect(artifactUrl("/roadside/scene.glb")).toBe("/roadside/scene.glb");
  });
});
