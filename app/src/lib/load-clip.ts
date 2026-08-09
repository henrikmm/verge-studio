/**
 * Getting a video into the pipeline, from wherever it was chosen.
 *
 * There are now two places to load a clip — the Inspector's Clip section, which is the default
 * first thing anyone sees, and the Frame Source node card in the Graph, which is where it used to
 * be and still works. They are two VIEWS of one node's parameters, not two ways of holding the
 * same fact: both write `frame-source`, so the graph, the cache key and the run registry cannot
 * end up disagreeing about which clip is loaded.
 *
 * The upload itself is not incidental. A browser never hands out a real path, and ffmpeg needs
 * one, so the dev server copies the file into a temp directory and returns where it put it, along
 * with the content digest that keys measurement targets to a clip.
 */

import { runAuto, setNodeParams } from "../graph/graph-store";
import { uploadVideo } from "./infer-client";

export const FRAME_SOURCE_ID = "frame-source";

/**
 * Copy the file somewhere ffmpeg can reach, point Frame Source at it, and let the graph catch up.
 *
 * Returns nothing and throws on failure: every caller has its own place to show the error, and a
 * swallowed upload failure would leave the pane looking as though nothing had been clicked.
 */
export async function loadClip(file: File): Promise<void> {
  const source = await uploadVideo(file);
  setNodeParams(FRAME_SOURCE_ID, {
    videoPath: source.path,
    videoName: source.name,
    videoSha256: source.sha256,
    durationS: source.durationS,
  });
  // Auto nodes only. DA3 is manual and stays manual — this must never be the thing that spends
  // GPU time, whatever the badges say.
  await runAuto();
}
