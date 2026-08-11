/**
 * Every sampled frame in one image.
 *
 * The question this answers cannot be answered by a number: *did it sample the whole clip?* A
 * frame count and an effective rate are consistent with a run that took 112 frames from the first
 * three seconds, and nothing on screen has ever distinguished that from a correct one. Sampling
 * across the whole clip is the mechanism this project's accuracy comes from — a single viewpoint
 * produces badly wrong geometry — so it is worth being able to see.
 *
 * It costs nothing. The frames are already JPEGs on local disk, served by the dev middleware that
 * extracted them; this draws them into a canvas. No new route, no upload, no GPU.
 *
 * Clicking a cell moves Depth 2D to that frame, which makes the sheet a way of navigating the
 * clip rather than only a way of checking it.
 */

import { useEffect, useRef, useState } from "react";
import { frameUrl } from "../lib/infer-client";
import { setMeasurementFrame } from "../measurement/measurement-store";

/** Internal pixel width of one cell. The canvas is then scaled to the pane by CSS. */
const CELL_WIDTH = 96;
/** How many images are fetched at once. Local disk, but 112 parallel decodes still stutters. */
const CONCURRENCY = 8;

function columnsFor(count: number): number {
  return Math.max(1, Math.min(12, Math.ceil(Math.sqrt(count))));
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    // A missing frame draws as an empty cell rather than taking the whole sheet down. The
    // extraction directory lives in the OS temp dir and can be reaped underneath us.
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export function ContactSheet({
  paths,
  referenceIndex,
}: {
  paths: string[];
  /** The frame DA3 anchors the reconstruction on, outlined so it can be found. */
  referenceIndex: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(0);
  const [cellHeight, setCellHeight] = useState(54);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || paths.length === 0) return;
    let cancelled = false;
    setDrawn(0);

    void (async () => {
      const columns = columnsFor(paths.length);
      const rows = Math.ceil(paths.length / columns);

      // The first frame sets the aspect for every cell. They all come from one clip at one
      // scale, so measuring one is measuring all of them — and it avoids sizing the canvas
      // before anything is known, which would make the sheet jump once loading starts.
      const first = await loadImage(frameUrl(paths[0]!));
      if (cancelled) return;
      const aspect = first && first.width > 0 ? first.height / first.width : 9 / 16;
      const height = Math.round(CELL_WIDTH * aspect);
      setCellHeight(height);

      canvas.width = columns * CELL_WIDTH;
      canvas.height = rows * height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#0d0d0f";
      context.fillRect(0, 0, canvas.width, canvas.height);

      let done = 0;
      const drawAt = (index: number, image: HTMLImageElement | null) => {
        const x = (index % columns) * CELL_WIDTH;
        const y = Math.floor(index / columns) * height;
        if (image) context.drawImage(image, x, y, CELL_WIDTH, height);
        // 1 px of background between cells, so a run of similar frames still reads as
        // separate frames rather than one smeared picture.
        context.strokeStyle = "#0d0d0f";
        context.lineWidth = 1;
        context.strokeRect(x + 0.5, y + 0.5, CELL_WIDTH - 1, height - 1);
        if (index === referenceIndex) {
          context.strokeStyle = "#f4f4f6";
          context.lineWidth = 2;
          context.strokeRect(x + 1, y + 1, CELL_WIDTH - 2, height - 2);
        }
        done += 1;
        setDrawn(done);
      };

      drawAt(0, first);

      for (let start = 1; start < paths.length; start += CONCURRENCY) {
        if (cancelled) return;
        const batch = paths.slice(start, start + CONCURRENCY);
        const images = await Promise.all(batch.map((path) => loadImage(frameUrl(path))));
        if (cancelled) return;
        images.forEach((image, offset) => drawAt(start + offset, image));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [paths, referenceIndex]);

  if (paths.length === 0) return null;

  const columns = columnsFor(paths.length);

  return (
    <div className="contact-sheet">
      <canvas
        ref={canvasRef}
        className="contact-sheet-canvas"
        // A grid of frames is a picture of the sampling, and the alt text has to carry the same
        // fact for somebody who cannot see it.
        role="img"
        aria-label={`${paths.length} sampled frames, spread evenly across the whole clip`}
        onClick={(event) => {
          const canvas = event.currentTarget;
          const box = canvas.getBoundingClientRect();
          const column = Math.floor(((event.clientX - box.left) / box.width) * columns);
          const row = Math.floor(
            ((event.clientY - box.top) / box.height) * Math.ceil(paths.length / columns),
          );
          const index = row * columns + column;
          if (index < 0 || index >= paths.length) return;
          // Canonical frame numbering is 1-based — `frame-0001.jpg` is npz index 0.
          setMeasurementFrame(index + 1);
        }}
      />
      <div className="contact-sheet-foot">
        <span className="mono">
          {drawn < paths.length ? `${drawn} / ${paths.length}` : `${paths.length} frames`}
        </span>
        <span className="hint">
          {drawn < paths.length
            ? "drawing…"
            : `outlined cell is the reference view · click a frame to open it in Depth 2D · cells are ${CELL_WIDTH}×${cellHeight}`}
        </span>
      </div>
    </div>
  );
}
