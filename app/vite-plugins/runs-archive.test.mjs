/**
 * Recorded evidence is archived, never destroyed.
 *
 * This is the half of the delete story that no assertion covered. The store's tests prove the
 * session forgets a removed target's trials; these prove the bytes behind them are still on disk
 * afterwards. Getting that wrong is unrecoverable in a way nothing else in this repository is: a
 * run can be computed again, a mask painted by a person on one afternoon cannot.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN_ID = "20260811-161356-d387ec";
let root;
let runs;

/** A packet shaped like the real thing, down to the fields the archive filters on. */
function packet(objectId, trialIndex, capturedAt) {
  return {
    schemaVersion: "verge.measurement-evidence/0.3.0",
    runId: RUN_ID,
    run: { id: RUN_ID, label: "RoomNewFixture.mp4 · 504 px · 112f" },
    target: { id: objectId, name: objectId, truthM: 0.44 },
    observation: {
      id: `${objectId}:${RUN_ID}#${trialIndex}`,
      objectId,
      runId: RUN_ID,
      trialIndex,
      rawM: 0.44,
      sittingId: "sitting-test",
      capturedAt,
      mask: { digest: `digest-${objectId}-${trialIndex}`, runs: [0, 4], width: 2, height: 2 },
    },
  };
}

async function seed(packets) {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, RUN_ID, "measurements"), { recursive: true });
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({
      version: 1,
      runs: [{ id: RUN_ID, label: "RoomNewFixture", persisted: true, builtin: false, clipSha256: "sha-room" }],
    }),
  );
  for (const [index, item] of packets.entries()) {
    await writeFile(join(root, RUN_ID, "measurements", `measurement-${index}.json`), JSON.stringify(item));
  }
}

const archived = () => readdir(join(root, ".archive", RUN_ID));
const live = () => readdir(join(root, RUN_ID, "measurements"));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "verge-archive-"));
  // RUNS_ROOT is resolved once, at import. Point it somewhere disposable BEFORE loading.
  process.env.VERGE_RUNS_ROOT = root;
  runs = await import("./runs.mjs");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await seed([
    packet("pc-tower", 1, "2026-08-12T22:46:43.924Z"),
    packet("pc-tower", 2, "2026-08-12T22:46:51.825Z"),
    packet("table", 1, "2026-08-12T22:44:22.734Z"),
  ]);
});

describe("archiving a target's evidence", () => {
  it("moves only that target's trials, and keeps the rest readable", async () => {
    const moved = await runs.archiveMeasurementEvidence(RUN_ID, {
      objectIds: ["pc-tower"],
      reason: "target pc-tower removed",
    });

    expect(moved).toHaveLength(2);
    expect(await live()).toHaveLength(1);
    expect(await archived()).toHaveLength(2);
    const remaining = await runs.listMeasurementEvidence(RUN_ID);
    expect(remaining.map((item) => item.observation.objectId)).toEqual(["table"]);
  });

  it("stamps why and when, without disturbing the recording itself", async () => {
    await runs.archiveMeasurementEvidence(RUN_ID, { objectIds: ["table"], reason: "target table removed" });
    const [name] = await archived();
    const stored = JSON.parse(await readFile(join(root, ".archive", RUN_ID, name), "utf8"));

    expect(stored.archivedReason).toBe("target table removed");
    expect(Date.parse(stored.archivedAt)).toBeGreaterThan(0);
    // The evidence itself is byte-for-byte what was recorded. An archive that edited the
    // measurement would be a worse record than no archive at all.
    expect(stored.observation).toEqual(packet("table", 1, "2026-08-12T22:44:22.734Z").observation);
  });

  it("is invisible to the app afterwards, so a trial cannot come back and be counted twice", async () => {
    await runs.archiveMeasurementEvidence(RUN_ID, { objectIds: ["pc-tower", "table"] });
    expect(await runs.listMeasurementEvidence(RUN_ID)).toEqual([]);
  });

  it("keeps both copies when one evidence id is archived twice", async () => {
    const trial = packet("table", 1, "2026-08-12T22:44:22.734Z");
    await runs.archiveMeasurementEvidence(RUN_ID, { objectIds: ["table"] });
    // The same recording, recovered and recorded again — two archiving events, and the second
    // must not overwrite the first's file.
    await writeFile(join(root, RUN_ID, "measurements", "measurement-again.json"), JSON.stringify(trial));
    await runs.archiveMeasurementEvidence(RUN_ID, { objectIds: ["table"] });
    expect(await archived()).toHaveLength(2);
  });

  it("discards one trial by evidence id, leaving its siblings", async () => {
    const [first] = await runs.listMeasurementEvidence(RUN_ID);
    const moved = await runs.removeMeasurementEvidence(RUN_ID, first.evidenceId);

    expect(moved).toEqual([first.evidenceId]);
    const remaining = await runs.listMeasurementEvidence(RUN_ID);
    expect(remaining.map((item) => item.evidenceId)).not.toContain(first.evidenceId);
    expect(remaining).toHaveLength(2);
  });
});

describe("deleting a run", () => {
  it("archives every trial and the run record before removing the bytes", async () => {
    const result = await runs.deleteRun(RUN_ID);

    expect(result).toEqual({ deleted: RUN_ID, archived: 3 });
    expect(existsSync(join(root, RUN_ID))).toBe(false);
    const kept = await archived();
    expect(kept.filter((name) => name.startsWith("measurement-"))).toHaveLength(3);
    // What the trials were measured on, so an archived measurement still says what it measured.
    const record = JSON.parse(await readFile(join(root, ".archive", RUN_ID, "run.json"), "utf8"));
    expect(record.id).toBe(RUN_ID);
    expect(Date.parse(record.archivedAt)).toBeGreaterThan(0);
  });

  it("rescues an unreadable packet rather than letting the delete destroy it", async () => {
    await writeFile(join(root, RUN_ID, "measurements", "measurement-broken.json"), "{ truncated");
    await runs.deleteRun(RUN_ID);

    expect(await archived()).toContain("measurement-broken.json");
  });

  it("refuses to touch a built-in fixture run", async () => {
    await expect(runs.deleteRun("door-504px-112f")).rejects.toThrow(/built-in/);
  });
});
