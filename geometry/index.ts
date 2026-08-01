/**
 * geometry/ — only what DA3 does not already give us.
 *
 * DA3 hands back metric depth, confidence, intrinsics, extrinsics and a world-space
 * point cloud. What it does NOT know is which way is up, where the floor is, or how tall
 * anything is. That is this package, and nothing more: no re-implementation of DA3's own
 * geometry, per docs/SOURCES.md.
 *
 * Everything here is pure and dependency-free, so it tests headlessly against synthetic
 * scenes with exactly known answers — which is the only way to tell a geometry bug apart
 * from a reconstruction problem.
 */

export * from "./types";
export * from "./gravity";
export * from "./plane";
export * from "./backproject";
export * from "./measure";
export * from "./calibrate";
