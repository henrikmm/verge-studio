/**
 * The window split, pinned.
 *
 * The layout is meant to be 40% Depth 2D, 40% Viewport 3D, 20% for the Setup group, and on
 * 2026-08-11 nobody could say whether it still was — Dockview persists whatever you drag it to
 * and nothing on screen reported the result. It measured exactly right (512/512/256 at 1280 px),
 * but "measured right once, in a console" is not a property anybody can rely on tomorrow.
 *
 * Two things now defend it. `PaneShare` draws each pane's share in its status row, so a drifted
 * layout is visible rather than inferred. And this file pins the arithmetic those shares are
 * supposed to agree with, without needing a browser.
 */

import { describe, expect, it } from "vitest";
import { SIDE_PANEL_SHARE, defaultColumnWidths } from "./dock-store";

describe("the default column split", () => {
  it("is 40/40/20 at the width the checklist is graded at", () => {
    const { depth, viewport, side } = defaultColumnWidths(1280);
    expect(depth).toBe(512);
    expect(viewport).toBe(512);
    expect(side).toBe(256);
  });

  // The two panes you look at are equals; the panel you read gets what is left. An asymmetry
  // here is the exact defect the 40/40/20 split was introduced to remove.
  it("keeps the two viewers equal at every width", () => {
    for (const width of [1024, 1280, 1440, 1600, 1920, 2560, 3440]) {
      const { depth, viewport } = defaultColumnWidths(width);
      expect(depth, `${width}px`).toBe(viewport);
    }
  });

  it("never loses or invents a pixel", () => {
    for (const width of [1024, 1279, 1280, 1281, 1600, 1920, 2560]) {
      const { depth, viewport, side } = defaultColumnWidths(width);
      expect(depth + viewport + side, `${width}px`).toBe(width);
    }
  });

  /**
   * Rounding moves the side panel, never the viewers, because the viewers are computed and the
   * side is the remainder. At an odd width that is a one-pixel difference and it must land in the
   * column whose exact width nobody is grading.
   */
  it("gives the side column at most a pixel of slack from rounding", () => {
    for (const width of [1279, 1281, 1333, 1999]) {
      const { side } = defaultColumnWidths(width);
      expect(Math.abs(side - width * SIDE_PANEL_SHARE), `${width}px`).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The bound is 0.08 percentage points, not zero and not a round number.
   *
   * Rounding the viewer width to a whole pixel is what moves it, and the error is largest at the
   * narrowest width because a pixel is a bigger share of it: at 1024 px the side column measures
   * **19.92%**, which is half a pixel of slack. Anything tighter would be asserting arithmetic
   * that integer pixels cannot deliver.
   */
  it("holds each share to within 0.08 points of its target from 1024 px up", () => {
    for (const width of [1024, 1280, 1600, 1920, 2560, 3440]) {
      const { depth, side } = defaultColumnWidths(width);
      expect(Math.abs((depth / width) * 100 - 40), `${width}px depth`).toBeLessThanOrEqual(0.08);
      expect(Math.abs((side / width) * 100 - 20), `${width}px side`).toBeLessThanOrEqual(0.08);
    }
  });
});
