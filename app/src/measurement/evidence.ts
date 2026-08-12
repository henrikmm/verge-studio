import type { RunRecord } from "../lib/runs";
import type { GroundPlaneValue, MeasurementValue, SelectionValue } from "../graph/nodes";
import type { MeasurementObject, MeasurementObservation } from "./measurement-store";
import { localApiHeaders } from "../lib/local-api";

export const MEASUREMENT_EVIDENCE_SCHEMA = "verge.measurement-evidence/0.2.0";

/** Stable across reloads and unique across browser sittings, unlike the human trial number. */
export function measurementEvidenceId(observation: MeasurementObservation): string {
  return [
    observation.id,
    observation.sittingId,
    observation.capturedAt,
    observation.mask?.digest ?? "no-mask",
  ].join("@");
}

/** Everything needed to identify and replay one explicit named-object recording. */
export interface MeasurementEvidencePacket {
  schemaVersion: typeof MEASUREMENT_EVIDENCE_SCHEMA;
  evidenceId: string;
  runId: string;
  run: Pick<RunRecord, "id" | "label" | "clipName" | "clipSha256" | "createdAt" | "frameCount" | "processRes">;
  target: MeasurementObject | null;
  observation: MeasurementObservation;
  live?: {
    cloudSource?: "glb" | "npz";
    selection: {
      rejected: SelectionValue["diagnostics"]["rejected"];
      maskedPixels: number;
      pointCount: number;
    };
    measurement: Pick<MeasurementValue, "mode" | "rawM" | "internalSpreadM" | "pointCount" | "ruler" | "rulerKind" | "details">;
    ground: {
      plane: GroundPlaneValue["plane"];
      supportFraction: number;
      rmseM: number;
      tiltDeg: number;
      belowFraction: number;
      gravityCoherence: number;
    };
  };
}

async function expectOk(response: Response): Promise<unknown> {
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

export async function saveMeasurementEvidence(packet: MeasurementEvidencePacket): Promise<void> {
  await expectOk(
    await fetch(`/api/runs/${encodeURIComponent(packet.runId)}/measurements`, {
      method: "POST",
      headers: localApiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(packet),
    }),
  );
}

export async function listMeasurementEvidence(runId: string): Promise<MeasurementEvidencePacket[]> {
  const result = (await expectOk(
    await fetch(`/api/runs/${encodeURIComponent(runId)}/measurements`),
  )) as { measurements: MeasurementEvidencePacket[] };
  return result.measurements;
}

export async function deleteMeasurementEvidence(runId: string, evidenceId: string): Promise<void> {
  await expectOk(
    await fetch(
      `/api/runs/${encodeURIComponent(runId)}/measurements/${encodeURIComponent(evidenceId)}`,
      { method: "DELETE", headers: localApiHeaders() },
    ),
  );
}
