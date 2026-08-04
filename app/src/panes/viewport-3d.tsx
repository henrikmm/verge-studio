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
import { resolveCurrentInput, resolveInput, useGraph } from "../graph/graph-store";
import {
  VIEWER_3D_ID,
  type GroundPlaneValue,
  type MeasurementValue,
  type PointCloudValue,
  type SelectionValue,
} from "../graph/nodes";
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
  const evidenceRef = useRef<THREE.Group>(null);

  const [frameMs, setFrameMs] = useState(0);
  const [paused, setPaused] = useState(false);
  /**
   * Read inside the render loop, which is created once and must not be torn down and rebuilt
   * every time Pause is clicked — that would drop the WebGL context and the whole scene with it.
   * Until 2026-08-04 the Pause button set state that nothing consumed, so the loop kept running
   * and the control did nothing at all.
   */
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const [output, setOutput] = useState("points");

  const graph = useGraph();
  const incoming = resolveInput(graph, VIEWER_3D_ID, "points");
  const cloud = incoming?.value as PointCloudValue | undefined;
  const ground = resolveCurrentInput(graph, VIEWER_3D_ID, "plane")?.value as GroundPlaneValue | undefined;
  const selection = resolveCurrentInput(graph, VIEWER_3D_ID, "selection")?.value as SelectionValue | undefined;
  const measurement = resolveCurrentInput(graph, VIEWER_3D_ID, "measurement")?.value as MeasurementValue | undefined;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0a0a0c");
    sceneRef.current = scene;
    const evidence = new THREE.Group();
    evidence.name = "measurement-evidence";
    scene.add(evidence);
    evidenceRef.current = evidence;

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
      // Paused still schedules the next frame so resuming is instant, but does no work: no
      // controls update, no render, no timing sample. `last` still advances, or the first
      // frame after a resume would report the length of the pause as a frame time.
      if (pausedRef.current) {
        last = now;
        return;
      }
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
      evidenceRef.current = null;
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

  useEffect(() => {
    const evidence = evidenceRef.current;
    if (!evidence) return;
    for (const child of [...evidence.children]) {
      evidence.remove(child);
      if (child instanceof THREE.Points || child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) material.dispose();
      }
    }

    if (ground && cloud) {
      const evidenceGeometry = new THREE.BufferGeometry();
      evidenceGeometry.setAttribute("position", new THREE.BufferAttribute(ground.evidence.points, 3));
      const support = new THREE.Points(
        evidenceGeometry,
        new THREE.PointsMaterial({
          color: "#f3c969",
          size: Math.max(0.004, cloud.extent / 900),
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.75,
        }),
      );
      support.name = "floor-support-points";
      evidence.add(support);

      const radius = Math.min(cloud.extent * 0.35, ground.evidence.radius * 1.05);
      const geometry = new THREE.CircleGeometry(Math.max(0.2, radius), 64);
      const material = new THREE.MeshBasicMaterial({
        color: "#f3c969",
        transparent: true,
        opacity: 0.09,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const floor = new THREE.Mesh(geometry, material);
      floor.name = "fitted-floor";
      floor.position.set(...ground.evidence.center);
      floor.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(...ground.plane.normal),
      );
      evidence.add(floor);
    }

    if (selection && selection.points.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(selection.points, 3));
      const points = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color: "#fb7185",
          size: Math.max(0.005, (cloud?.extent ?? 5) / 450),
          sizeAttenuation: true,
          depthTest: false,
        }),
      );
      points.renderOrder = 4;
      points.name = "selected-points";
      evidence.add(points);
    }

    if (measurement) {
      const vertices = new Float32Array([...measurement.ruler.bottom, ...measurement.ruler.top]);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
      const rulerMaterial = new THREE.LineBasicMaterial({ color: "#e8a95b", depthTest: false });
      const ruler = new THREE.Line(geometry, rulerMaterial);
      ruler.renderOrder = 5;
      ruler.name = "measurement-ruler";
      evidence.add(ruler);

      const markerRadius = Math.max(0.008, (cloud?.extent ?? 5) / 180);
      for (const [name, position] of [
        ["ruler-bottom", measurement.ruler.bottom],
        ["ruler-top", measurement.ruler.top],
      ] as const) {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(markerRadius, 12, 8),
          new THREE.MeshBasicMaterial({ color: "#e8a95b", depthTest: false }),
        );
        marker.position.set(...position);
        marker.renderOrder = 6;
        marker.name = name;
        evidence.add(marker);
      }
    }
  }, [cloud, ground, measurement, selection]);

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
        {ground && (
          <div className="viewport-overlay">
            FLOOR {(ground.fit.inlierFraction * 100).toFixed(1)}% SUPPORT · {ground.fit.tiltDeg.toFixed(1)}° TILT · {(ground.fit.rmse * 100).toFixed(1)} cm RMSE
            {measurement && <><br />{measurement.rulerKind === "extent" ? "EXTENT" : "HEIGHT ABOVE FLOOR"} <b>{measurement.rawM.toFixed(3)} m</b> · spread ±{measurement.internalSpreadM.toFixed(3)} m</>}
          </div>
        )}
        {!cloud && (
          <div className="pane-empty">
            Nothing on the wire yet — drop a clip on Frame Source, then run DA3 Depth.
          </div>
        )}
      </div>
    </div>
  );
}
