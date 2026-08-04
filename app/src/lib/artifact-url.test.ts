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
import { artifactUrl } from "./infer-client";

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
    // _publish emits gs:// when VERGE_OUTPUT_BUCKET is set. No bucket exists today, but
    // silently building "https://…/gs://…" would be a baffling 404 if one ever appears.
    expect(() => artifactUrl("gs://bucket/runs/scene.glb")).toThrow(/signed URL/);
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
