import type { RunRecord } from "../lib/runs";
import type { GroundPlaneValue, MeasurementValue, SelectionValue } from "../graph/nodes";
import type { MeasurementObject, MeasurementObservation } from "./measurement-store";
import { localApiHeaders } from "../lib/local-api";

/**
 * 0.3.0 froze the ruler into `observation` itself. It was already written under `live.measurement`
 * by an explicit Record, but the recovery path merges observations and drops everything else, so
 * the endpoints came back off disk nowhere. Readers are tolerant in both directions: nothing
 * validates this string, older packets simply have no ruler, and `inspect` prefers whichever copy
 * a packet carries.
 */
export const MEASUREMENT_EVIDENCE_SCHEMA = "verge.measurement-evidence/0.3.0";

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

/**
 * The trial inside a packet, with its ruler wherever that packet happens to keep it.
 *
 * Schema 0.3.0 freezes the endpoints into the observation, which is the part the recovery path
 * merges. Packets written under 0.2.0 have the same endpoints one level out, under
 * `live.measurement` — frozen at the same instant by the same Record, and merely stored somewhere
 * nothing looked. Lifting them is not a re-derivation: no geometry runs here, and a packet with
 * neither copy stays without one, because recomputing a ruler needs the floor of the session that
 * recorded it. Of the 60 packets in `~/verge-runs` on 2026-08-12, this recovers 9.
 */
export function recoveredObservation(packet: MeasurementEvidencePacket): MeasurementObservation {
  const stored = packet.live?.measurement;
  if (packet.observation.ruler || !stored?.ruler) return packet.observation;
  return { ...packet.observation, ruler: stored.ruler, rulerKind: stored.rulerKind };
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
