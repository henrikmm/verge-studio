#!/usr/bin/env node
// Rebuild the whole measurement study from the frozen trial packets, in one command.
//
// Every graded number this project publishes comes from a hand-painted mask recorded months
// apart across several clips. Quoting them in a document is cheap and being wrong about them is
// invisible, so this script does not read the numbers out of the packets and print them: it
// REPLAYS each trial through `inspect measurement`, which back-projects the frozen mask, refits
// nothing, and measures again. A row is published only if the replay reproduces the stored
// reading. That turns the results table from a transcription into a check that fails loudly.
//
// It is also what stops evidence collection being tedious enough to skip. Seventeen trials at two
// images each is forty minutes of careful clicking, or twenty seconds of this.
//
//   node scripts/collect-evidence.mjs                       every run that has trials
//   node scripts/collect-evidence.mjs --run 20260814        one run
//   node scripts/collect-evidence.mjs --out docs/evidence   somewhere other than .inspect/evidence
//
// Writes, into the output directory: the two images per trial that `inspect measurement --focus`
// draws, a machine-readable `manifest.json`, and `SUMMARY.md` — the table meant for a document,
// grouped by clip and target, with the median, the spread and the error against tape.
//
// Local and free. It never contacts the cloud and never touches a run's own directory.

import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const inspect = join(here, "inspect.mjs");

/**
 * How closely a replay must reproduce the stored reading to be published.
 *
 * The replay is deterministic arithmetic over the same frozen mask, so the honest expectation is
 * zero and the observed figure across every trial on this disk is 0.000 mm. A tenth of a
 * millimetre is therefore a floating-point allowance, not a tolerance for disagreement — anything
 * that actually drifts is a defect in the measurement path and must stop the collection.
 */
const REPLAY_TOLERANCE_MM = 0.1;

async function inspectJson(args) {
  const { stdout } = await run("node", [inspect, ...args, "--json"], {
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function main() {
  const flags = parse(process.argv.slice(2));
  const outDir = resolve(repo, flags.out ?? ".inspect/evidence");
  const size = String(flags.size ?? 900);
  const margin = String(flags.focus ?? 0.75);
  await mkdir(outDir, { recursive: true });

  const { runs } = await inspectJson(["runs"]);
  const wanted = flags.run
    ? runs.filter((entry) => entry.id.startsWith(String(flags.run)))
    : runs;
  if (!wanted.length) throw new Error(`no run matches "${flags.run}"`);

  const trials = [];
  const failures = [];

  for (const entry of wanted) {
    let listed;
    try {
      listed = await inspectJson(["measurements", entry.id]);
    } catch (error) {
      // A run whose payload is absent from this clone cannot be replayed, and that is a fact
      // about the disk rather than a defect. Record it and carry on.
      failures.push({ run: entry.id, stage: "list", reason: message(error) });
      continue;
    }
    if (!listed.measurements.length) continue;

    process.stderr.write(`${entry.id} — ${listed.measurements.length} trials\n`);

    for (const row of listed.measurements) {
      let replay;
      try {
        replay = await inspectJson([
          "measurement", entry.id, row.id,
          "--focus", margin,
          "--size", size,
        ]);
      } catch (error) {
        failures.push({ run: entry.id, trial: row.id, stage: "replay", reason: message(error) });
        continue;
      }

      const driftMm = Math.abs(replay.replayM - replay.storedM) * 1000;
      if (driftMm > REPLAY_TOLERANCE_MM) {
        failures.push({
          run: entry.id,
          trial: row.id,
          stage: "replay",
          reason: `replay ${replay.replayM.toFixed(6)} m disagrees with stored ${replay.storedM.toFixed(6)} m by ${driftMm.toFixed(3)} mm`,
        });
        continue;
      }

      // `inspect measurement` names its images after the run and the trial INDEX, so two targets
      // in one run both write "…-measurement-1-mask.png" and the second silently replaces the
      // first. Copying each image out under the trial's own id, immediately, is what makes a
      // whole run's evidence survive being collected in one pass.
      const slug = row.id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const images = {};
      for (const [key, source] of [
        ["frame", replay.photograph],
        ["cloud", replay.cloud],
        ["cloudFramed", replay["cloud, framed"]],
      ]) {
        if (!source || !source.startsWith("/")) continue;
        const name = `${slug}-${key === "cloudFramed" ? "3d-framed" : key === "cloud" ? "3d" : "frame"}.png`;
        await copyFile(source, join(outDir, name));
        images[key] = name;
      }

      trials.push({
        run: entry.id,
        clip: entry.clipName ?? null,
        trial: row.id,
        target: row.target,
        frame: row.frame,
        storedM: replay.storedM,
        replayM: replay.replayM,
        replayDriftMm: driftMm,
        truthM: row.truth,
        errorM: row.error,
        maskDigest: row.mask,
        maskPixels: row.pixels,
        keptRuler: row.ruler,
        gravityControlM: replay.diagnostics.gravityControlM,
        automaticMask: replay.diagnostics.automaticMask ?? false,
        fullMaskControlM: replay.diagnostics.fullMaskControlM ?? null,
        endpointAdapterDeltaM: replay.diagnostics.endpointAdapterDeltaM ?? null,
        roundTripHits: replay.roundTripHits,
        roundTripMisses: replay.roundTripMisses,
        images: {
          frame: images.frame ?? null,
          cloud: images.cloud ?? null,
          cloudFramed: images.cloudFramed ?? null,
        },
      });
    }
  }

  const groups = group(trials);
  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: "scripts/collect-evidence.mjs",
    replayToleranceMm: REPLAY_TOLERANCE_MM,
    trialCount: trials.length,
    targetCount: groups.length,
    // A collection with failures in it is still worth keeping — but it must say so in the file
    // that gets read, not only in a terminal somebody has closed.
    failures,
    targets: groups,
    trials,
  };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outDir, "SUMMARY.md"), summary(manifest));

  process.stderr.write(
    `\n${trials.length} trials over ${groups.length} targets → ${relative(repo, outDir)}\n` +
    `  manifest.json  SUMMARY.md  ${trials.length * 3} images\n`,
  );
  if (failures.length) {
    process.stderr.write(`\n${failures.length} FAILURES\n`);
    for (const failure of failures) {
      process.stderr.write(`  ${failure.run} ${failure.trial ?? ""} — ${failure.reason}\n`);
    }
    process.exitCode = 1;
  }
}

/**
 * Collapse trials into one row per target.
 *
 * The median is what this project reports, because three trials is where a mean is still hostage
 * to one bad paint. `spreadM` is max−min, which AGENTS calls the honest statement of operator
 * variation at three to five trials — it is not an uncertainty and must never be quoted as one.
 */
function group(trials) {
  const byTarget = new Map();
  for (const trial of trials) {
    const key = `${trial.run}::${trial.target}`;
    if (!byTarget.has(key)) {
      byTarget.set(key, {
        run: trial.run,
        clip: trial.clip,
        target: trial.target,
        truthM: trial.truthM,
        trials: [],
      });
    }
    byTarget.get(key).trials.push(trial);
  }

  return [...byTarget.values()].map((entry) => {
    const values = entry.trials.map((trial) => trial.storedM).sort((a, b) => a - b);
    const median = values.length % 2
      ? values[(values.length - 1) / 2]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const truth = entry.truthM;
    return {
      run: entry.run,
      clip: entry.clip,
      target: entry.target,
      truthM: truth,
      // A target measured through the automatic mask carries the endpoint adapter, and a table
      // that mixes the two without saying so compares two instruments as if they were one.
      maskSource: entry.trials.every((trial) => trial.automaticMask)
        ? "automatic"
        : entry.trials.some((trial) => trial.automaticMask) ? "mixed" : "brush",
      n: values.length,
      medianM: median,
      meanM: mean,
      spreadM: values[values.length - 1] - values[0],
      errorM: Number.isFinite(truth) ? median - truth : null,
      errorPct: Number.isFinite(truth) && truth !== 0 ? ((median - truth) / truth) * 100 : null,
      trials: entry.trials.map((trial) => trial.trial),
    };
  });
}

function summary(manifest) {
  const lines = [];
  lines.push("# Measurement evidence — replayed from the frozen masks");
  lines.push("");
  lines.push(`Generated by \`${manifest.generator}\` at ${manifest.generatedAt}.`);
  lines.push("");
  lines.push(
    `Every row below was recomputed from its recorded mask rather than copied out of the packet. ` +
    `All ${manifest.trialCount} replays reproduced their stored reading to within ` +
    `${manifest.replayToleranceMm} mm.`,
  );
  lines.push("");
  lines.push("**Spread is `max − min` across the trials of one sitting. It is operator");
  lines.push("repeatability, not measurement uncertainty.**");
  lines.push("");

  const clips = [...new Set(manifest.targets.map((target) => target.clip ?? target.run))];
  for (const clip of clips) {
    const rows = manifest.targets.filter((target) => (target.clip ?? target.run) === clip);
    lines.push(`## ${clip}`);
    lines.push("");
    lines.push(`\`${rows[0].run}\``);
    lines.push("");
    lines.push("| Target | Mask | Truth | n | Median | Error | Error % | Spread |");
    lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
    for (const row of rows) {
      lines.push([
        "",
        row.target,
        row.maskSource,
        row.truthM === null ? "—" : `${row.truthM.toFixed(3)} m`,
        row.n,
        `${row.medianM.toFixed(4)} m`,
        row.errorM === null ? "—" : `${signed(row.errorM, 4)} m`,
        row.errorPct === null ? "—" : `${signed(row.errorPct, 1)}%`,
        `${(row.spreadM * 1000).toFixed(1)} mm`,
        "",
      ].join(" | ").trim());
    }
    lines.push("");
  }

  lines.push("## Every trial");
  lines.push("");
  lines.push("| Trial | Target | Frame | Reading | Truth | Error | Mask px | Replay drift |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const trial of manifest.trials) {
    lines.push([
      "",
      `\`${trial.trial.split(":")[0]}#${trial.trial.split("#")[1]}\``,
      trial.target,
      trial.frame,
      `${trial.storedM.toFixed(4)} m`,
      trial.truthM === null ? "—" : `${trial.truthM.toFixed(3)} m`,
      trial.errorM === null ? "—" : `${signed(trial.errorM, 4)} m`,
      trial.maskPixels.toLocaleString("en-GB"),
      `${trial.replayDriftMm.toFixed(3)} mm`,
      "",
    ].join(" | ").trim());
  }
  lines.push("");

  if (manifest.failures.length) {
    lines.push("## Failures");
    lines.push("");
    for (const failure of manifest.failures) {
      lines.push(`- \`${failure.run}\` ${failure.trial ?? ""} (${failure.stage}) — ${failure.reason}`);
    }
    lines.push("");
  }

  lines.push("## Images");
  lines.push("");
  lines.push("Three per trial: the recorded mask on its source frame, the selection in the whole");
  lines.push("cloud, and the same selection framed on its ruler in elevation with the fitted floor");
  lines.push("drawn across it.");
  lines.push("");
  for (const trial of manifest.trials) {
    lines.push(`- **${trial.target}** \`${trial.trial}\` — \`${trial.images.frame ?? "—"}\` · \`${trial.images.cloudFramed ?? "—"}\``);
  }
  lines.push("");
  return lines.join("\n");
}

const signed = (value, digits) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
const message = (error) => String(error.stderr || error.message).trim().split("\n").pop();

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
