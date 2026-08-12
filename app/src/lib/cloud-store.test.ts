/**
 * The cost-safety properties, pinned as tests.
 *
 * Cloud Run bills instance lifetime, so the failure mode here is not a wrong pixel — it is a
 * GPU instance quietly billing after the operator believed they had stopped it. Each of these
 * corresponds to a real gap found in the 2026-08-04 audit.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  connectCloud,
  disconnectCloud,
  getCloud,
  inferBase,
  instanceElapsedMs,
  isBilling,
  isRemote,
  markServiceDeleted,
  noteRequest,
  noteRun,
} from "./cloud-store";

const REMOTE = "https://verge-da3-abc123-uc.a.run.app";

// Deleting is the only full reset — disconnecting keeps the billing memory by design.
afterEach(() => {
  markServiceDeleted();
  disconnectCloud();
});

describe("cloud session identity", () => {
  it("uses the local middleware until a service is explicitly connected", () => {
    expect(isRemote()).toBe(false);
    expect(inferBase()).toBe("/api");
    expect(getCloud().state).toBe("local");
  });

  it("routes GPU calls at the connected service and strips a trailing slash", () => {
    connectCloud(`${REMOTE}/`, "tok");
    expect(isRemote()).toBe(true);
    expect(inferBase()).toBe(REMOTE);
  });

  it("clears the token on disconnect so it cannot leak into a later session", () => {
    connectCloud(REMOTE, "secret-token");
    disconnectCloud();
    expect(getCloud().token).toBe("");
  });

  it("refuses to attach a bearer token to an unapproved host", () => {
    expect(() => connectCloud("https://attacker.invalid", "secret-token")).toThrow("unapproved");
    expect(getCloud().token).toBe("");
  });
});

describe("the instance clock", () => {
  it("does not start until a request has actually reached the service", () => {
    connectCloud(REMOTE, "");
    // Connecting is intent, not proof. Nothing is billing until something answers.
    expect(instanceElapsedMs(getCloud())).toBeNull();
    expect(isBilling(getCloud())).toBe(false);
  });

  it("starts on the first request and keeps running across later ones", () => {
    connectCloud(REMOTE, "");
    noteRequest();
    const first = getCloud().firstContactAt;
    expect(first).not.toBeNull();
    noteRequest();
    // The clock measures the INSTANCE, not the last request — it must never be reset.
    expect(getCloud().firstContactAt).toBe(first);
    expect(getCloud().requestCount).toBe(2);
  });

  it("never starts a clock for local mock traffic", () => {
    noteRequest();
    expect(getCloud().firstContactAt).toBeNull();
    expect(isBilling(getCloud())).toBe(false);
  });

  it("reports elapsed time from first contact", () => {
    connectCloud(REMOTE, "");
    noteRequest();
    const started = getCloud().firstContactAt ?? 0;
    expect(instanceElapsedMs(getCloud(), started + 90_000)).toBe(90_000);
  });
});

describe("what actually stops the meter", () => {
  it("still counts as billing after a disconnect — pointing away does not delete anything", () => {
    connectCloud(REMOTE, "");
    noteRequest();
    expect(isBilling(getCloud())).toBe(true);
    disconnectCloud();
    // The instance outlives the app's opinion about where inference points. Reporting "not
    // billing" here would be a false all-clear at exactly the moment it is most dangerous.
    expect(getCloud().baseUrl).toBeNull();
    expect(isBilling(getCloud())).toBe(true);
    expect(instanceElapsedMs(getCloud())).not.toBeNull();
  });

  it("stops counting as billing only once the service is deleted", () => {
    connectCloud(REMOTE, "");
    noteRequest();
    markServiceDeleted();
    expect(isBilling(getCloud())).toBe(false);
    expect(getCloud().deleted).toBe(true);
    expect(instanceElapsedMs(getCloud())).toBeNull();
  });
});

describe("run accounting", () => {
  it("counts billable runs separately from ordinary requests", () => {
    connectCloud(REMOTE, "");
    noteRequest();
    noteRequest();
    noteRun();
    expect(getCloud().requestCount).toBe(2);
    expect(getCloud().runCount).toBe(1);
  });
});
