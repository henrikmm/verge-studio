/**
 * Where the geometry on screen came from.
 *
 * This exists because of a real misdiagnosis on 2026-08-05. With no service connected, the dev
 * middleware answers /infer with the roadside donor fixture, and `depthFieldFromRun()` builds
 * RGB descriptors from the *locally extracted* frames while taking depth, cameras and the GLB
 * from the manifest. A mock run therefore wears the new clip's face and carries an unrelated
 * scene's geometry — and the operator reasonably concluded the pipeline was broken.
 *
 * Three places said "mock" and none was where anyone was looking: the status bar, the inspector
 * and the DA3 card's summary. The two panes that actually *display* the geometry said nothing.
 * They do now.
 */

import type { DepthFieldValue } from "../measurement/depth-field";

export function ProvenanceBanner({ field }: { field: DepthFieldValue | undefined }) {
  // A real GPU run needs no badge: it is the case where what you see is what you asked for.
  if (!field || field.source === "gpu") return null;

  if (field.source === "mock") {
    return (
      <div className="provenance mock">
        <b>MOCK RUN</b> — this geometry is the built-in roadside fixture, not your clip. The
        frames are yours; the depth, cameras and point cloud are not. Connect a service in
        Inspector → Cloud control to run DA3 for real.
      </div>
    );
  }
  return <div className="provenance fixture">RECORDED RUN · {field.label}</div>;
}
