import { useSyncExternalStore } from "react";
import type { FixtureSetting } from "./depth-field";

export type MeasurementMode = "top_above_floor" | "vertical_extent";

export interface MeasurementObject {
  id: string;
  code: string;
  name: string;
  definition: string;
  truthM: number;
  mode: MeasurementMode;
  suggestedFrame: number;
  maskInstruction: string;
  availabilityNote?: string;
  maskOwnerId?: string;
}

export const MEASUREMENT_OBJECTS: readonly MeasurementObject[] = [
  {
    id: "door-leaf",
    code: "B1",
    name: "Door leaf",
    definition: "physical leaf, bottom edge to top edge",
    truthM: 2.1,
    mode: "vertical_extent",
    suggestedFrame: 1,
    maskInstruction: "Paint the door leaf continuously from its bottom edge to its top edge.",
  },
  {
    id: "table-top",
    code: "B2",
    name: "Table top",
    definition: "floor plane to tabletop surface",
    truthM: 0.75,
    mode: "vertical_extent",
    suggestedFrame: 231,
    maskInstruction: "Paint the tabletop edge and a visible floor patch; a connecting stroke is fine.",
  },
  {
    id: "pc-tower",
    code: "B3",
    name: "PC tower",
    definition: "tower base on tabletop to tower top",
    truthM: 0.45,
    mode: "vertical_extent",
    suggestedFrame: 187,
    maskInstruction: "Paint the tower continuously from its tabletop contact to its top.",
  },
  {
    id: "monitor-own",
    code: "B4",
    name: "Monitor + stand",
    definition: "stand contact on tabletop to screen top",
    truthM: 0.534,
    mode: "vertical_extent",
    suggestedFrame: 219,
    maskInstruction: "Paint from the stand/table contact to the top of the screen.",
    availabilityNote: "The laptop occludes the stand/table contact in the recorded clip. Do not grade B4 without another view.",
  },
  {
    id: "monitor-top",
    code: "B5",
    name: "Monitor top",
    definition: "floor plane to screen top; also checked as B2 + B4",
    truthM: 1.284,
    mode: "vertical_extent",
    suggestedFrame: 219,
    maskInstruction: "Paint the screen top and a visible floor patch; a connecting stroke is fine.",
  },
] as const;

export interface MaskRecord {
  width: number;
  height: number;
  data: Uint8Array;
  revision: number;
}

export interface MeasurementObservation {
  id: string;
  objectId: string;
  setting: FixtureSetting;
  canonicalFrame: number;
  npzFrame: number;
  rawM: number;
  internalSpreadM: number;
  pointCount: number;
  confidenceThreshold: number;
  floorRmseM: number;
  floorSupportFraction?: number;
  floorTiltDeg: number;
  floorBelowFraction: number;
  gravityCoherence: number;
  capturedAt: string;
}

export interface MeasurementUiState {
  activeObjectId: string;
  canonicalFrame: number;
  brushSize: number;
  erasing: boolean;
  overlayOpacity: number;
  confidencePercentile: number;
  zoom: number;
  masks: Record<string, MaskRecord>;
  observations: MeasurementObservation[];
}

const STORAGE_KEY = "verge.m3b.measurement-session/0.1.0";
const first = MEASUREMENT_OBJECTS[0];

function encodeMask(mask: MaskRecord): number[] {
  const runs: number[] = [];
  for (let index = 0; index < mask.data.length; ) {
    if (!mask.data[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < mask.data.length && mask.data[index]) index += 1;
    runs.push(start, index - start);
  }
  return runs;
}

function decodeMask(value: { width: number; height: number; revision: number; runs: number[] }): MaskRecord {
  const data = new Uint8Array(value.width * value.height);
  for (let i = 0; i + 1 < value.runs.length; i += 2) {
    data.fill(1, value.runs[i], value.runs[i] + value.runs[i + 1]);
  }
  return { width: value.width, height: value.height, revision: value.revision, data };
}

function restoreSession(): Partial<MeasurementUiState> {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw) as {
      activeObjectId?: string;
      canonicalFrame?: number;
      confidencePercentile?: number;
      masks?: Record<string, { width: number; height: number; revision: number; runs: number[] }>;
      observations?: MeasurementObservation[];
    };
    return {
      activeObjectId: saved.activeObjectId,
      canonicalFrame: saved.canonicalFrame,
      confidencePercentile: saved.confidencePercentile,
      masks: Object.fromEntries(
        Object.entries(saved.masks ?? {}).map(([key, mask]) => [key, decodeMask(mask)]),
      ),
      observations: saved.observations ?? [],
    };
  } catch {
    return {};
  }
}

const restored = restoreSession();
const state: MeasurementUiState = {
  activeObjectId: first.id,
  canonicalFrame: first.suggestedFrame,
  brushSize: 28,
  erasing: false,
  overlayOpacity: 0.55,
  confidencePercentile: 20,
  zoom: 1,
  masks: {},
  observations: [],
  ...restored,
};

const listeners = new Set<() => void>();
let snapshot: MeasurementUiState = { ...state };
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function persistSession(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  const masks = Object.fromEntries(
    Object.entries(state.masks).map(([key, mask]) => [
      key,
      { width: mask.width, height: mask.height, revision: mask.revision, runs: encodeMask(mask) },
    ]),
  );
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      activeObjectId: state.activeObjectId,
      canonicalFrame: state.canonicalFrame,
      confidencePercentile: state.confidencePercentile,
      masks,
      observations: state.observations,
    }),
  );
}

function commit(): void {
  snapshot = { ...state };
  for (const listener of listeners) listener();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSession, 350);
}

export function useMeasurementUi(): MeasurementUiState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

export function getMeasurementUi(): MeasurementUiState {
  return state;
}

export function activeMeasurementObject(): MeasurementObject {
  return MEASUREMENT_OBJECTS.find((item) => item.id === state.activeObjectId) ?? first;
}

export function setActiveMeasurementObject(objectId: string): void {
  const object = MEASUREMENT_OBJECTS.find((item) => item.id === objectId);
  if (!object) return;
  state.activeObjectId = object.id;
  state.canonicalFrame = object.suggestedFrame;
  commit();
}

export function setMeasurementFrame(canonicalFrame: number): void {
  state.canonicalFrame = Math.max(1, Math.round(canonicalFrame));
  commit();
}

export function setBrushSize(size: number): void {
  state.brushSize = Math.max(2, Math.min(120, Math.round(size)));
  commit();
}

export function setErasing(erasing: boolean): void {
  state.erasing = erasing;
  commit();
}

export function setOverlayOpacity(opacity: number): void {
  state.overlayOpacity = Math.max(0.05, Math.min(1, opacity));
  commit();
}

export function setConfidencePercentile(value: number): void {
  state.confidencePercentile = Math.max(0, Math.min(95, value));
  commit();
}

export function setMeasurementZoom(value: number): void {
  state.zoom = Math.max(1, Math.min(4, value));
  commit();
}

function maskKey(objectId = state.activeObjectId, frame = state.canonicalFrame): string {
  const object = MEASUREMENT_OBJECTS.find((item) => item.id === objectId);
  return `${object?.maskOwnerId ?? objectId}:${frame}`;
}

export function getMask(objectId = state.activeObjectId, frame = state.canonicalFrame): MaskRecord | undefined {
  return state.masks[maskKey(objectId, frame)];
}

export function ensureMask(width: number, height: number): MaskRecord {
  const key = maskKey();
  const existing = state.masks[key];
  if (existing && existing.width === width && existing.height === height) return existing;
  const created = { width, height, data: new Uint8Array(width * height), revision: 0 };
  state.masks = { ...state.masks, [key]: created };
  commit();
  return created;
}

export function paintMask(x: number, y: number, radius: number, erase: boolean): MaskRecord {
  const current = getMask();
  if (!current) throw new Error("mask canvas has not been initialised");
  const data = current.data.slice();
  const left = Math.max(0, Math.floor(x - radius));
  const right = Math.min(current.width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius));
  const bottom = Math.min(current.height - 1, Math.ceil(y + radius));
  const radiusSq = radius * radius;
  for (let py = top; py <= bottom; py++) {
    for (let px = left; px <= right; px++) {
      if ((px - x) ** 2 + (py - y) ** 2 <= radiusSq) {
        data[py * current.width + px] = erase ? 0 : 1;
      }
    }
  }
  const next = { ...current, data, revision: current.revision + 1 };
  state.masks = { ...state.masks, [maskKey()]: next };
  commit();
  return next;
}

export function paintMaskStroke(
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  erase: boolean,
): MaskRecord {
  const current = getMask();
  if (!current) throw new Error("mask canvas has not been initialised");
  const data = current.data.slice();
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.45)));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const left = Math.max(0, Math.floor(x - radius));
    const right = Math.min(current.width - 1, Math.ceil(x + radius));
    const top = Math.max(0, Math.floor(y - radius));
    const bottom = Math.min(current.height - 1, Math.ceil(y + radius));
    const radiusSq = radius * radius;
    for (let py = top; py <= bottom; py++) {
      for (let px = left; px <= right; px++) {
        if ((px - x) ** 2 + (py - y) ** 2 <= radiusSq) {
          data[py * current.width + px] = erase ? 0 : 1;
        }
      }
    }
  }
  const next = { ...current, data, revision: current.revision + 1 };
  state.masks = { ...state.masks, [maskKey()]: next };
  commit();
  return next;
}

export function clearActiveMask(): void {
  const current = getMask();
  if (!current) return;
  state.masks = {
    ...state.masks,
    [maskKey()]: { ...current, data: new Uint8Array(current.data.length), revision: current.revision + 1 },
  };
  commit();
}

export function setMaskData(
  objectId: string,
  canonicalFrame: number,
  width: number,
  height: number,
  data: Uint8Array,
): void {
  if (data.length !== width * height) throw new Error("mask dimensions do not match its data");
  const key = maskKey(objectId, canonicalFrame);
  const revision = (state.masks[key]?.revision ?? 0) + 1;
  state.masks = { ...state.masks, [key]: { width, height, data: data.slice(), revision } };
  commit();
}

export function addObservation(observation: Omit<MeasurementObservation, "id" | "capturedAt">): void {
  const sameEvidence = (item: MeasurementObservation) =>
    item.objectId === observation.objectId &&
    item.setting === observation.setting &&
    item.canonicalFrame === observation.canonicalFrame;
  const record: MeasurementObservation = {
    ...observation,
    id: `${observation.objectId}:${observation.setting}:${observation.canonicalFrame}`,
    capturedAt: new Date().toISOString(),
  };
  state.observations = [...state.observations.filter((item) => !sameEvidence(item)), record];
  commit();
}

export function clearObservations(): void {
  state.observations = [];
  commit();
}

export function exportMeasurementSession(): string {
  const masks = Object.fromEntries(
    Object.entries(state.masks).map(([key, mask]) => [
      key,
      {
        width: mask.width,
        height: mask.height,
        revision: mask.revision,
        paintedPixels: mask.data.reduce((a, b) => a + b, 0),
        runs: encodeMask(mask),
      },
    ]),
  );
  return JSON.stringify(
    {
      schemaVersion: "verge.measurement-session/0.1.0",
      definitions: MEASUREMENT_OBJECTS,
      observations: state.observations,
      masks,
    },
    null,
    2,
  );
}
