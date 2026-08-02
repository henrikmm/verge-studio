/**
 * Dev-only scripting handle for the node graph.
 *
 * Verification needs to drive the graph without a human at the mouse, and the two
 * things that matter most are the hardest to automate: loading a clip (drag-and-drop
 * cannot be synthesised for a 172 MB file) and triggering a GPU run. Both are reachable
 * here instead.
 *
 * Tree-shaken out of production builds by the `import.meta.env.DEV` guard at the call
 * site — this exists for the browser-pane feedback loop, not for shipping.
 */

import {
  getGraph,
  nodeById,
  run,
  runNode,
  setNodeParam,
  setNodeParams,
  isNodeStale,
} from "../graph/graph-store";
import { clearActiveMask, exportMeasurementSession, setMaskData } from "../measurement/measurement-store";

export function installDevHandle(): void {
  if (!import.meta.env.DEV) return;

  const handle = {
    getGraph,
    nodeById,
    setNodeParam,
    setNodeParams,
    isNodeStale,
    run,
    runNode,
    clearActiveMask,
    setMaskData,
    exportMeasurementSession,

    /** Point Frame Source at a clip already on disk, bypassing drag-and-drop. */
    loadVideo(path: string, name = path.split("/").pop() ?? "clip.mp4") {
      setNodeParams("frame-source", { videoPath: path, videoName: name });
      return getGraph().nodes.find((n) => n.id === "frame-source")?.params;
    },

    /** Compact view of the graph: what ran, what is stale, how long it took. */
    summary() {
      const state = getGraph();
      return state.nodes.map((n) => {
        const rt = state.runtime[n.id];
        return {
          id: n.id,
          status: rt?.status ?? "idle",
          stale: isNodeStale(state, n.id),
          ms: rt?.elapsedMs ?? 0,
          error: rt?.error ?? null,
          outputs: Object.keys(rt?.outputs ?? {}),
        };
      });
    },

    /** The manifest the DA3 node last produced — the thing a cloud run must deliver. */
    manifest() {
      const outputs = getGraph().runtime["da3-depth"]?.outputs;
      const field = outputs?.depth?.value as { manifest?: unknown } | undefined;
      return field?.manifest ?? null;
    },
  };

  (window as unknown as Record<string, unknown>).__verge = handle;
}
