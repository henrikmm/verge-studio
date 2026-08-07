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
  type MeasurementValue,
  type PointCloudValue,
  type SelectionValue,
} from "../graph/nodes";
import type { DepthFieldValue } from "../measurement/depth-field";
import {
  buildGridSegments,
  chooseGridSpacing,
  collectPointsBelow,
  disposeSubtree,
} from "./floor-overlay";
import { readFloorState } from "./floor-state";
import { LayerRow, OutputRow, PaneControls, type LayerChoice } from "./pane-chrome";
import { ProvenanceBanner } from "./provenance";

const GIZMO_PX = 72;

const OUTPUTS = [
  { id: "points", label: "Points" },
  { id: "cameras", label: "+ Cameras" },
];

const FLOOR_PLANE_LAYER = "floor-plane";
const FLOOR_POINTS_LAYER = "floor-points";
const FLOOR_UP_LAYER = "floor-up";
const BELOW_PLANE_LAYER = "below-plane";

/** Colours are the type legend from DESIGN.md, not decoration. See each layer below. */
const PLANE_HUE = "#f3c969"; // --port-plane: everything that IS the fitted plane
const NEUTRAL_HUE = "#f4f4f6"; // --emph-hi: the camera's own vertical, which is not a port type
const ATTENTION_HUE = "#f59e0b"; // --accent-busy: the app's one "look at this" hue

/**
 * Off by default, deliberately.
 *
 * The fitted floor is a claim about the scene, not part of it, and until 2026-08-07 it was drawn
 * unconditionally with no way to remove it — so it sat over every screenshot of the cloud and
 * nobody could compare "with" against "without". Showing it is now an act: you turn it on to
 * check the fit, and what you see is an answer to a question you asked.
 */
const LAYERS: LayerChoice[] = [
  {
    id: FLOOR_PLANE_LAYER,
    label: "Floor grid",
    title:
      "The fitted ground as a metric grid, clipped to the evidence supporting it. Straight lines converge in perspective, so this is what shows whether the floor is level and sits at the base of the walls.",
  },
  {
    id: FLOOR_POINTS_LAYER,
    label: "Floor points",
    title: "The cloud points the plane rests on — where its evidence actually is.",
  },
  {
    id: FLOOR_UP_LAYER,
    label: "Up axes",
    title:
      "Two arrows from the plane's centre: the floor's own normal, and the vertical derived from the camera path. The angle between them is the reported tilt, drawn.",
  },
  {
    id: BELOW_PLANE_LAYER,
    label: "Below plane",
    title:
      "Every cloud point more than 5 cm under the floor. The ground is the surface with almost nothing beneath it, so a large lit-up region means the fit landed part way up the scene.",
  },
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
  const [layers, setLayers] = useState<ReadonlySet<string>>(() => new Set<string>());

  const graph = useGraph();
  const incoming = resolveInput(graph, VIEWER_3D_ID, "points");
  // The cloud itself carries no provenance — it is a GLB. Read it from the depth field that
  // produced it, one hop upstream, so the banner cannot disagree with what is rendered.
  const provenance = resolveInput(graph, "point-cloud", "depth")?.value as
    | DepthFieldValue
    | undefined;
  const cloud = incoming?.value as PointCloudValue | undefined;
  const floor = useMemo(() => readFloorState(graph), [graph]);
  const ground = floor.kind === "ok" ? floor.ground : undefined;
  const selection = resolveCurrentInput(graph, VIEWER_3D_ID, "selection")?.value as SelectionValue | undefined;
  const measurement = resolveCurrentInput(graph, VIEWER_3D_ID, "measurement")?.value as MeasurementValue | undefined;

  const toggleLayer = (id: string) =>
    setLayers((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });

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

  const showFloorPlane = layers.has(FLOOR_PLANE_LAYER);
  const showFloorPoints = layers.has(FLOOR_POINTS_LAYER);
  const showUpAxes = layers.has(FLOOR_UP_LAYER);
  const showBelow = layers.has(BELOW_PLANE_LAYER);

  /** Radius the whole overlay shares, so grid, disc and arrows agree on one extent. */
  const floorRadius =
    ground && cloud ? Math.max(0.2, Math.min(cloud.extent * 0.35, ground.evidence.radius * 1.05)) : 0;
  const gridSpacing = chooseGridSpacing(floorRadius);

  useEffect(() => {
    const evidence = evidenceRef.current;
    if (!evidence) return;
    for (const child of [...evidence.children]) {
      evidence.remove(child);
      disposeSubtree(child);
    }

    // Built only when switched on, rather than built and hidden: a layer nobody asked for should
    // cost no GPU memory, and the ~9k-point support set is cheap enough to rebuild on a click.
    if (ground && cloud && showFloorPoints) {
      const evidenceGeometry = new THREE.BufferGeometry();
      evidenceGeometry.setAttribute("position", new THREE.BufferAttribute(ground.evidence.points, 3));
      const support = new THREE.Points(
        evidenceGeometry,
        new THREE.PointsMaterial({
          color: PLANE_HUE,
          size: Math.max(0.004, cloud.extent / 900),
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.75,
        }),
      );
      support.name = "floor-support-points";
      evidence.add(support);
    }

    if (ground && cloud && showFloorPlane) {
      // A faint fill so the floor reads as a surface, and the grid on top so it reads as a LEVEL
      // one. The fill alone was the old overlay: at 9% opacity it was a smudge, and a flat wash
      // carries no perspective cue at all, which is exactly the cue tilt is visible in.
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(floorRadius, 64),
        new THREE.MeshBasicMaterial({
          color: PLANE_HUE,
          transparent: true,
          opacity: 0.06,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      disc.name = "fitted-floor";
      disc.position.set(...ground.evidence.center);
      disc.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(...ground.plane.normal),
      );
      evidence.add(disc);

      const segments = buildGridSegments(
        ground.plane,
        ground.evidence.center,
        floorRadius,
        gridSpacing,
      );
      const gridGeometry = new THREE.BufferGeometry();
      gridGeometry.setAttribute("position", new THREE.BufferAttribute(segments, 3));
      const grid = new THREE.LineSegments(
        gridGeometry,
        new THREE.LineBasicMaterial({ color: PLANE_HUE, transparent: true, opacity: 0.45 }),
      );
      grid.name = "fitted-floor-grid";
      evidence.add(grid);
    }

    if (ground && cloud && showUpAxes) {
      // Same origin and same length for both, so the ONLY difference the eye has to read is the
      // angle between them — which is the tilt the readout states in degrees.
      const origin = new THREE.Vector3(...ground.evidence.center);
      const length = Math.max(0.3, floorRadius * 0.8);
      for (const [name, direction, color] of [
        ["floor-normal", ground.plane.normal, PLANE_HUE],
        ["camera-up", ground.gravity.up, NEUTRAL_HUE],
      ] as const) {
        const arrow = new THREE.ArrowHelper(
          new THREE.Vector3(...direction).normalize(),
          origin,
          length,
          color,
          length * 0.16,
          length * 0.08,
        );
        arrow.name = name;
        evidence.add(arrow);
      }
    }

    if (ground && cloud && showBelow) {
      // The definition of ground, drawn. Same 5 cm test the reported BELOW percentage uses, so the
      // picture and the number cannot disagree.
      const below = collectPointsBelow(cloud.positions, ground.plane);
      if (below.length > 0) {
        const belowGeometry = new THREE.BufferGeometry();
        belowGeometry.setAttribute("position", new THREE.BufferAttribute(below, 3));
        const points = new THREE.Points(
          belowGeometry,
          new THREE.PointsMaterial({
            color: ATTENTION_HUE,
            size: Math.max(0.004, cloud.extent / 900),
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.85,
          }),
        );
        points.name = "points-below-floor";
        evidence.add(points);
      }
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
  }, [
    cloud,
    ground,
    measurement,
    selection,
    floorRadius,
    gridSpacing,
    showFloorPlane,
    showFloorPoints,
    showUpAxes,
    showBelow,
  ]);

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
        paneId="viewport"
        onPause={() => setPaused((p) => !p)}
        extra={<span className="pane-note">{status}</span>}
      />
      <OutputRow
        choices={OUTPUTS}
        active={output}
        onSelect={setOutput}
        hint="Left-drag=orbit, wheel=zoom, right-drag=pan"
      />
      {/*
        No hint text. Two earlier versions had one, and both wrapped this row to 36px against every
        other row's 19px — first because the sentence was long, then because four chips plus any
        hint at all will not fit a 405px pane. The chips carry their own state visibly and their
        tooltips carry the meaning, so the hint was the part with the least to say.
      */}
      <LayerRow choices={LAYERS} active={layers} onToggle={toggleLayer} />
      <ProvenanceBanner field={provenance} />
      <div className="pane-body" ref={hostRef}>
        {cloud && (
          <div className="viewport-overlay">
            {/*
              Three visibly different states, never silence. Amber-plus-◐ and red-plus-▲ follow the
              one status convention in the app: the glyph carries the meaning and the hue only
              reinforces it, so this survives a greyscale screenshot.
            */}
            {/*
              BELOW leads with SUPPORT because it is the number that decides whether this is the
              ground at all — 4.3% under the room fixture's real floor against 60.6% under the
              wrong mid-scene plane. It was computed on every fit since the rule was written, and
              until now it was recorded into the export file and shown in no pane at all.

              Second line carries the two things that qualify the first: how much the frames agreed
              about which way is up (a tilt measured against an incoherent vertical means little),
              and the grid's square size, which is only meaningful while the grid is drawn.
            */}
            {floor.kind === "ok" && (
              <>
                FLOOR {(floor.ground.fit.inlierFraction * 100).toFixed(1)}% SUPPORT · {(floor.ground.fit.belowFraction * 100).toFixed(1)}% BELOW · {floor.ground.fit.tiltDeg.toFixed(1)}° TILT · {(floor.ground.fit.rmse * 100).toFixed(1)} cm RMSE
                <br />
                CAMERA UP {floor.ground.gravity.coherence.toFixed(2)} COHERENCE
                {showFloorPlane && <> · GRID {gridSpacing} m</>}
              </>
            )}
            {floor.kind === "stale" && (
              <span className="overlay-stale">◐ FLOOR STALE — re-run the graph to see it</span>
            )}
            {floor.kind === "failed" && (
              <span className="overlay-failed">▲ NO FLOOR — {floor.message}</span>
            )}
            {/*
              Deliberately a sibling of the floor line, not a child of it. Nested inside the
              `ground &&` test, this readout vanished whenever the floor went stale — hiding a
              measurement the graph was still perfectly happy to report.
            */}
            {measurement && (
              <>
                {floor.kind !== "absent" && <br />}
                {measurement.rulerKind === "extent" ? "EXTENT" : "HEIGHT ABOVE FLOOR"} <b>{measurement.rawM.toFixed(3)} m</b> · spread ±{measurement.internalSpreadM.toFixed(3)} m
              </>
            )}
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
