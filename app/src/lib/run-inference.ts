/**
 * Pressing Run: what must be true first, and what happens after.
 *
 * The node itself only knows how to send frames somewhere. Two things around it were nobody's
 * job, and both cost real money:
 *
 * 1. **Nothing checked that a GPU existed.** Pressing Run with no service produced an HTTP error
 *    from deep in the client. An operator who did not already know that deploying comes first
 *    learned it from a stack trace, after the wait.
 * 2. **A finished run did not show itself.** `da3-depth` writes a depth field, but the viewers
 *    read `fixture-run`, whose `source` defaulted to `recorded` and was only ever changed from a
 *    dropdown in the Objects pane. So the sequence was: load a clip, pay for a run, and keep
 *    looking at the door fixture. The geometry on screen belonged to a different video.
 *
 * Both are properties of the *action*, not of the node, which is why they live here rather than
 * inside `graph/nodes/da3-depth.ts` — and why this module may import the graph store without
 * creating the cycle that putting them in the node would.
 */

import { FIXTURE_RUN_ID } from "../graph/nodes";
import { getGraph, nodeById, runAuto, runNode, setNodeParams } from "../graph/graph-store";
import type { FramesValue } from "../graph/nodes/frame-source";
import { getCloud } from "./cloud-store";
import { FRAME_SOURCE_ID } from "./load-clip";
import { beginRun, failRun, finishRun, resetRun } from "./run-phase";

export type PreconditionId = "clip" | "frames" | "target";

export interface Precondition {
  id: PreconditionId;
  label: string;
  ok: boolean;
  /** The current state, in a few words. Shown whether or not it is satisfied. */
  detail: string;
  /** What would satisfy it. Shown only when it is not. */
  fix?: string;
  /**
   * True when this step is satisfied by something that will NOT produce real geometry.
   *
   * The local mock returns the roadside fixture whatever you send it. That is what makes the
   * whole app buildable offline at zero cost, and it is also how a screenshot of an unrelated
   * scene once read as a successful run on a new video (REGISTRY section 8). So it satisfies the
   * step and says out loud what it is.
   */
  mock?: boolean;
}

/**
 * The three facts that decide whether Run may be pressed, in the order they must be fixed.
 *
 * Rendered as a checklist above the button rather than enforced silently, because the ordering
 * is the thing nobody knew. A disabled button that does not say what is missing is the failure
 * this replaces, not an improvement on it.
 */
export function preconditions(): Precondition[] {
  const graph = getGraph();
  const source = nodeById(graph, FRAME_SOURCE_ID);
  const clipName = String(source?.params.videoName ?? "");
  const frames = graph.runtime[FRAME_SOURCE_ID]?.outputs?.frames?.value as FramesValue | undefined;
  const frameCount = frames?.paths.length ?? 0;
  const cloud = getCloud();

  const target: Precondition = cloud.baseUrl === null
    ? {
        id: "target",
        label: "GPU service",
        ok: true,
        // Short enough to survive a 320 px pane without ellipsis. What the mock actually
        // returns is the note underneath, which has a full line to say it in.
        detail: "local mock · free",
        mock: true,
      }
    : cloud.state === "unreachable"
      ? {
          id: "target",
          label: "GPU service",
          ok: false,
          detail: cloud.error ?? "not answering",
          fix: "Check the service, or switch back to the local mock",
        }
      : {
          id: "target",
          label: "GPU service",
          ok: true,
          detail: cloud.serviceUrl ?? cloud.baseUrl,
        };

  return [
    {
      id: "clip",
      label: "Clip",
      ok: clipName !== "",
      detail: clipName || "none loaded",
      fix: "Drop a video above, or press Browse",
    },
    {
      id: "frames",
      label: "Frames",
      ok: frameCount > 0,
      detail: frameCount > 0 ? `${frameCount} extracted` : "not extracted yet",
      fix: "Press Extract frames",
    },
    target,
  ];
}

export function canRun(): boolean {
  return preconditions().every((step) => step.ok);
}

/**
 * Run the paid node, then point the app at what it produced.
 *
 * `runNode` resolves with a report rather than throwing — `runGraph` records an executor's error
 * on the node and carries on, so a failure has to be read back off the runtime. Without that, a
 * failed run would end in `finishRun()` and the readout would claim success.
 */
export async function runInference(): Promise<void> {
  if (!canRun()) return;
  beginRun();
  try {
    const report = await runNode("da3-depth");
    if (report.failed.includes("da3-depth")) {
      failRun(getGraph().runtime["da3-depth"]?.error ?? "the run failed");
      return;
    }
    /**
     * Already current, so nothing was sent and nothing was billed.
     *
     * The graph is content-addressed: pressing Run twice with nothing changed is a cache hit,
     * not a run. Treating that as a failure — which it was until this check existed — would
     * report an error for the app working exactly as designed, and would do it at the moment
     * the operator is most likely to press the button again and actually spend money.
     */
    if (!report.ran.includes("da3-depth")) {
      if (report.reused.includes("da3-depth")) {
        setNodeParams(FIXTURE_RUN_ID, { source: "live" });
        await runAuto();
        finishRun();
        return;
      }
      failRun("the run did not start — check the frames are still extracted");
      return;
    }
    /**
     * Show what was just paid for.
     *
     * `runAuto`, emphatically not `runNode` — the second pass must not be able to re-run the one
     * node that costs money. Pointing Run Source at the live branch restamps it and everything
     * downstream; DA3's own key is untouched, so it is reused rather than re-executed, and
     * `allowManual: false` would refuse it even if it were not.
     */
    setNodeParams(FIXTURE_RUN_ID, { source: "live" });
    await runAuto();
    finishRun();
  } catch (e) {
    failRun(e instanceof Error ? e.message : String(e));
  }
}

/** Clear a finished or failed readout, so the next attempt starts from nothing. */
export function clearRunReadout(): void {
  resetRun();
}
