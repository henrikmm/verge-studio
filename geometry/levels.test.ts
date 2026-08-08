/**
 * The level finder has to be right about a scene whose answer is known exactly, before it
 * is trusted on a scene whose answer is what we are trying to find out.
 */

import { describe, expect, it } from "vitest";
import { horizontalLevels, levelNear } from "./levels";
import { fitGroundPlane } from "./plane";
import { syntheticRoom } from "./synthetic";
import type { Plane, Vec3 } from "./types";

const FLOOR: Plane = { normal: [0, 1, 0], offset: 0 };

describe("horizontalLevels", () => {
  it("finds the floor, the table and the ceiling, and does not invent a wall", () => {
    const room = syntheticRoom({ tableHeight: 0.75 });
    const levels = horizontalLevels(room.points, FLOOR);

    // The walls span every height evenly, so they must not produce a level of their own.
    // Three surfaces exist in this room and three is what may be reported.
    expect(levels.length).toBe(3);

    const floor = levelNear(levels, 0, 0.05);
    const table = levelNear(levels, 0.75, 0.05);
    const ceiling = levelNear(levels, 2.5, 0.05);
    expect(floor?.height).toBeCloseTo(0, 3);
    expect(table?.height).toBeCloseTo(0.75, 3);
    expect(ceiling?.height).toBeCloseTo(2.5, 3);
  });

  it("measures a table of a different height, which is the whole point", () => {
    const room = syntheticRoom({ tableHeight: 0.42 });
    const table = levelNear(horizontalLevels(room.points, FLOOR), 0.42, 0.05);
    expect(table?.height).toBeCloseTo(0.42, 3);
  });

  function tipped(degrees: number): Plane {
    const radians = (degrees * Math.PI) / 180;
    return { normal: [Math.sin(radians), Math.cos(radians), 0] as Vec3, offset: 0 };
  }

  /**
   * The reading a mask cannot give: how wrong the floor's ORIENTATION is.
   *
   * Support, tilt and RMSE all describe a plane's agreement with the points it chose.
   * They are silent about a plane that is level with nothing. A 1.0 m wide tabletop read
   * against a reference tipped by θ has its heights smeared over 1.0 × sin θ, and the
   * robust spread of a smear that shape is about 0.4 of its width. Measured on this room
   * at 0.25°, 0.5° and 1°: 2.0 mm, 4.0 mm and 7.1 mm, against 1.7 mm, 3.5 mm and 7.0 mm
   * predicted. So the thickness of a surface the fit never used reads back the fit's own
   * orientation error, in millimetres.
   */
  it("reads the reference's tilt back out of a surface's thickness", () => {
    const room = syntheticRoom({ tableHeight: 0.75 });
    const thicknesses = [0, 0.25, 0.5, 1].map(
      (degrees) => levelNear(horizontalLevels(room.points, tipped(degrees)), 0.75, 0.05)!.thickness,
    );

    for (let i = 1; i < thicknesses.length; i++) {
      expect(thicknesses[i]).toBeGreaterThan(thicknesses[i - 1]);
    }
    // 1.0 m wide, tipped 1 deg, times the ~0.4 shape factor of a uniform smear.
    expect(thicknesses[3]).toBeGreaterThan(0.004);
    expect(thicknesses[3]).toBeLessThan(0.011);
  });

  /**
   * Past the point where a surface is still a surface, it must vanish rather than be
   * reported badly. At 2° this table's 3.5 cm smear is wider than the band that defines a
   * level, so no peak survives. That is the right failure: at 4° a peak does re-form, out
   * of 632 of the tabletop's 1022 points, and reports 0.7325 m — a confident answer that
   * is 1.7 cm wrong. Abstaining beats that.
   */
  it("declines to report a surface the reference has destroyed", () => {
    const room = syntheticRoom({ tableHeight: 0.75 });
    expect(levelNear(horizontalLevels(room.points, tipped(2)), 0.75, 0.1)).toBeNull();
  });

  it("survives reconstruction noise without losing the table", () => {
    const room = syntheticRoom({ tableHeight: 0.75, noise: 0.01 });
    const table = levelNear(horizontalLevels(room.points, FLOOR), 0.75, 0.05);
    expect(table?.height).toBeCloseTo(0.75, 2);
    expect(table!.thickness).toBeLessThan(0.02);
  });

  it("works in the rotated world frame DA3 actually hands us", () => {
    const room = syntheticRoom({ tableHeight: 0.75, rotate: true, noise: 0.004 });
    const fit = fitGroundPlane(room.points, { up: room.up });
    const table = levelNear(horizontalLevels(room.points, fit.plane), 0.75, 0.05);
    expect(table?.height).toBeCloseTo(0.75, 2);
  });

  it("returns nothing rather than guessing when the cloud is empty", () => {
    expect(horizontalLevels(new Float32Array(0), FLOOR)).toEqual([]);
  });

  it("finds no surface in a cloud that has none", () => {
    // One wall only: points spread evenly over every height, so no band stands out.
    const points: number[] = [];
    for (let i = 0; i < 4000; i++) points.push(0, (2.5 * i) / 3999, (i % 40) / 40);
    expect(horizontalLevels(Float32Array.from(points), FLOOR)).toEqual([]);
  });
});

describe("levelNear", () => {
  it("returns null when nothing is within tolerance", () => {
    const room = syntheticRoom({ tableHeight: 0.75 });
    const levels = horizontalLevels(room.points, FLOOR);
    expect(levelNear(levels, 1.6, 0.05)).toBeNull();
  });

  it("picks the closest surface when two are in range", () => {
    const room = syntheticRoom({ tableHeight: 0.75 });
    const levels = horizontalLevels(room.points, FLOOR);
    expect(levelNear(levels, 0.6, 0.9)?.height).toBeCloseTo(0.75, 2);
  });
});
