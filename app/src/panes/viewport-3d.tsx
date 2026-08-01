/**
 * Viewport 3D — a tap on the wire feeding the Viewport 3D node.
 *
 * It no longer loads a fixture path of its own: it renders whatever PointCloud
 * output arrives on its input. Offline that is the fixture (the mock's manifest
 * points at it); against a deployed service it is the run's GLB. Same code path,
 * which is what makes swapping to the cloud a base-URL change.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { resolveInput, useGraph } from "../graph/graph-store";
import { VIEWER_3D_ID, type PointCloudValue } from "../graph/nodes";
import { OutputRow, PaneControls } from "./pane-chrome";

const GIZMO_PX = 72;

const OUTPUTS = [
  { id: "points", label: "Points" },
  { id: "cameras", label: "+ Cameras" },
];

export function Viewport3D() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene>(null);
  const controlsRef = useRef<OrbitControls>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const mountedRef = useRef<THREE.Object3D>(null);

  const [frameMs, setFrameMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [output, setOutput] = useState("points");

  const graph = useGraph();
  const incoming = resolveInput(graph, VIEWER_3D_ID, "points");
  const cloud = incoming?.value as PointCloudValue | undefined;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0a0a0c");
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    camera.position.set(0, 0, 10);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controlsRef.current = controls;

    // Corner axes gizmo: separate scene, camera mirrors the main orbit rotation.
    const gizmoScene = new THREE.Scene();
    gizmoScene.add(new THREE.AxesHelper(1));
    const gizmoCam = new THREE.PerspectiveCamera(40, 1, 0.1, 10);

    let raf = 0;
    let last = performance.now();
    let emaMs = 0;
    let tick = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      emaMs = emaMs * 0.95 + (now - last) * 0.05;
      last = now;
      if (++tick % 30 === 0) setFrameMs(emaMs);

      controls.update();
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setViewport(0, 0, w, h);
      renderer.setScissorTest(false);
      renderer.render(scene, camera);

      gizmoCam.position.copy(camera.position).sub(controls.target).setLength(3);
      gizmoCam.lookAt(0, 0, 0);
      renderer.setViewport(w - GIZMO_PX, 0, GIZMO_PX, GIZMO_PX);
      renderer.setScissor(w - GIZMO_PX, 0, GIZMO_PX, GIZMO_PX);
      renderer.setScissorTest(true);
      renderer.render(gizmoScene, gizmoCam);
    };

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    animate();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  // Swap in whatever the wire is carrying. The PointCloud node already did the
  // loading, decimation and coloring, so this is a scene-graph swap, not a parse.
  useEffect(() => {
    const scene = sceneRef.current;
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!scene || !controls || !camera) return;

    if (mountedRef.current) {
      scene.remove(mountedRef.current);
      mountedRef.current = null;
    }
    if (!cloud) return;

    scene.add(cloud.object);
    mountedRef.current = cloud.object;

    const center = new THREE.Vector3(
      (cloud.bbox.min[0] + cloud.bbox.max[0]) / 2,
      (cloud.bbox.min[1] + cloud.bbox.max[1]) / 2,
      (cloud.bbox.min[2] + cloud.bbox.max[2]) / 2,
    );
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(0, -cloud.extent * 0.15, -cloud.extent * 0.6));
    camera.near = cloud.extent / 1000;
    camera.far = cloud.extent * 10;
    camera.updateProjectionMatrix();
  }, [cloud]);

  // DA3's GLB carries camera frustums alongside the points; the chip toggles them.
  // Only the frustum geometry itself may be hidden — toggling every non-Points object
  // would also hide the groups the points hang off, blanking the whole scene.
  useEffect(() => {
    if (!cloud) return;
    cloud.object.traverse((child) => {
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.visible = output === "cameras";
      }
    });
  }, [cloud, output]);

  const status = useMemo(() => {
    if (!cloud) return "no input";
    return `${cloud.pointCount.toLocaleString()} pts`;
  }, [cloud]);

  return (
    <div className="pane">
      <PaneControls
        status={cloud ? "Running" : "Idle"}
        elapsedMs={frameMs}
        paused={paused}
        onPause={() => setPaused((p) => !p)}
        extra={<span className="pane-note">{status}</span>}
      />
      <OutputRow
        choices={OUTPUTS}
        active={output}
        onSelect={setOutput}
        hint="Left-drag=orbit, wheel=zoom, right-drag=pan"
      />
      <div className="pane-body" ref={hostRef}>
        {!cloud && (
          <div className="pane-empty">
            Nothing on the wire yet — drop a clip on Frame Source, then run DA3 Depth.
          </div>
        )}
      </div>
    </div>
  );
}
