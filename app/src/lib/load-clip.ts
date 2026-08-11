/**
 * Getting a video into the pipeline, and — separately — doing the work.
 *
 * There are two places to load a clip: the Setup pane, which is what anyone sees first, and the
 * Frame Source node card in the Graph, which is where it used to be and still works. They are two
 * VIEWS of one node's parameters, not two copies of the same fact — both write `frame-source`, so
 * the graph, the cache key and the run registry cannot end up disagreeing about which clip is
 * loaded.
 *
 * The upload itself is not incidental. A browser never hands out a real path, and ffmpeg needs
 * one, so the dev server copies the file into a temp directory and returns where it put it, along
 * with the content digest that keys measurement targets to a clip.
 *
 * ## Why loading no longer extracts
 *
 * Until 2026-08-11 `loadClip` ended with `runAuto()`, so dropping a file started ffmpeg
 * immediately at whatever sampling rate happened to be set, and the frame plan rendered
 * afterwards — describing work already done. Measured on this Mac: 1.7 s for a 13.5 s 1080p clip
 * and 11.7 s for a 15.8 s 4K60 one, paid again on every settle of a slider, because the sampling
 * controls call `setNodeParamAndRun`.
 *
 * Now the two are separate acts. Loading probes the file, which is cheap and tells us everything
 * the plan needs. Extracting is a press. The arithmetic in between is free.
 */

import { runNode, setNodeParams } from "../graph/graph-store";
import { uploadVideo } from "./infer-client";

export const FRAME_SOURCE_ID = "frame-source";

/**
 * Copy the file somewhere ffmpeg can reach and point Frame Source at it. Nothing is extracted.
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
    nativeFps: source.nativeFps,
    width: source.width,
    height: source.height,
  });
}

/**
 * Sample the clip. This is the ffmpeg pass, and the only expensive thing on this side.
 *
 * Clears exactly one manual node — Frame Source. DA3 is manual too and stays stale, so this can
 * never be the thing that spends GPU time, whatever the badges say.
 */
export async function extractClipFrames(): Promise<void> {
  await runNode(FRAME_SOURCE_ID);
}
