/**
 * Viewport 3D — a tap on the wire feeding the Viewport 3D node.
 *
 * It no longer loads a fixture path of its own: it renders whatever PointCloud
 * output arrives on its input. Offline that is the fixture (the mock's manifest
 * points at it); against a deployed service it is the run's GLB. Same code path,
 * which is what makes swapping to the cloud a base-URL change.
 *
 * ## Three ways to be in the scene
 *
 * **Free** is the orbit camera, now with keyboard navigation (`viewport-nav.ts`) so a trackpad is
 * not the only way through a cloud. The keys move the whole rig — camera and pivot together — so
 * dragging still orbits exactly as it did, around whatever you have walked up to.
 *
 * **Fixed** puts the viewer where the recording camera stood, for the frame the slider is on
 * (`camera-track.ts`). That makes this pane and Depth 2D the same viewpoint at the same index, so
 * a reconstruction that has drifted stops being a feeling and becomes a visible disagreement —
 * especially with the video ghosted over it.
 *
 * **Cinematic** turns the scene by itself (`cinematic.ts`), because a still image of a point cloud
 * is the least convincing way to show one: what makes it read as a place rather than as speckle is
 * parallax, and parallax needs motion.
 *
 * ## Standard and Advanced
 *
 * This pane reached six control rows and nineteen buttons, and the readout over the scene led with
 * four numbers about how the ground plane was fitted. All of it is useful while debugging a fit;
 * none of it is what a person wants when they are looking at a reconstruction. Standard keeps the
 * view modes, the camera toggle and the measurement; everything else is behind the switch in the
 * status bar (`lib/ui-mode.ts`). Entering Standard clears the layer set — hiding the switch for
 * something still being drawn would leave an effect with no way to turn it off.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { cross, dot, normalize, signedHeight, type Vec3 } from "../../../geometry";
import {
  resolveCurrentInput,
  resolveInput,
  setNodeParamAndRun,
  useGraph,
} from "../graph/graph-store";
import {
  CLOUD_BUDGETS,
  CLOUD_COLOURS,
  CLOUD_SOURCES,
  POINT_CLOUD_ID,
  VIEWER_3D_ID,
  type CloudColour,
  type CloudSource,
  type MeasurementValue,
  type PointCloudValue,
  type SelectionValue,
} from "../graph/nodes";
import { useAdvanced } from "../lib/ui-mode";
import { closestFrame, type DepthFieldValue } from "../measurement/depth-field";
import { activeMeasurementObject, useMeasurementUi } from "../measurement/measurement-store";
import {
  ORBIT_RATE_DEG_S,
  angleFacing,
  cinematicPose,
  rateFactor,
  type CinematicScene,
} from "./cinematic";
import { describeResult, type ResultKind, type ResultReadout } from "./result-strip";
import { HelpDot } from "./help";
import {
  LOOK_PITCH_LIMIT,
  aimedOrientation,
  cameraTrack,
  ease,
  fitFovDeg,
  recordedFrameRect,
  type CameraPose,
  type CameraTrack,
} from "./camera-track";
import {
  buildGridSegments,
  chooseGridSpacing,
  collectPointsBelow,
  disposeSubtree,
} from "./floor-overlay";
import { readFloorState } from "./floor-state";
import {
  NAVIGATION_KEYS,
  clampPitch,
  navigationIntent,
  navigationKeyFor,
  resolveUpAxis,
  rotateAbout,
} from "./viewport-nav";
import { LayerRow, OutputRow, PaneControls, type LayerChoice } from "./pane-chrome";
import { ProvenanceBanner } from "./provenance";

const GIZMO_PX = 72;

type ViewMode = "free" | "fixed" | "cinematic";

const VIEW_MODES = [
  {
    id: "free",
    label: "Free",
    title: "Orbit and walk anywhere. Drag to orbit, WASD to move, arrows to look.",
  },
  {
    id: "fixed",
    label: "Fixed",
    title:
      "Stand where the recording camera stood for the frame the slider is on, with its field of view. You can turn to look around; you cannot walk.",
  },
  {
    id: "cinematic",
    label: "Cinematic",
    title:
      "Turn the scene by itself: a slow orbit above the fitted ground, a minute to the revolution. Drag or use the keys to steer it; the turn resumes a moment after you stop.",
  },
];

/** Keyboard steering rates in Cinematic, per second. Slower than Free's: this is trimming a shot,
 *  not travelling, and the same rate that feels responsive when walking overshoots here. */
const CINE_KEY_YAW = Math.PI / 3;
const CINE_KEY_PITCH = 0.5;
const CINE_KEY_ZOOM = 0.6;
/** Cap on the operator's own zoom, so a scroll cannot lose the scene entirely. */
const CINE_ZOOM_RANGE: readonly [number, number] = [0.35, 3];
/** How far the elevation may be trimmed from the shot's own, radians. */
const CINE_PITCH_LIMIT = 0.9;

const FLOOR_PLANE_LAYER = "floor-plane";
const FLOOR_POINTS_LAYER = "floor-points";
const FLOOR_UP_LAYER = "floor-up";
const BELOW_PLANE_LAYER = "below-plane";
const CAMERA_PATH_LAYER = "camera-path";

/** Colours are the type legend from DESIGN.md, not decoration. See each layer below. */
const PLANE_HUE = "#f3c969"; // --port-plane: everything that IS the fitted plane
const NEUTRAL_HUE = "#f4f4f6"; // --emph-hi: the camera's own vertical, which is not a port type
const ATTENTION_HUE = "#f59e0b"; // --accent-busy: the app's one "look at this" hue
const CAMERA_HUE = "#e879a0"; // --port-camera: the legend's own hue for camera data

/** How long the view takes to travel between two recorded poses, in milliseconds. */
const POSE_TWEEN_MS = 150;

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
  {
    id: CAMERA_PATH_LAYER,
    label: "Camera path",
    title:
      "The route the camera walked, with the current frame marked and aimed. Shows which part of the cloud a frame could actually see — without having to stand in it.",
  },
];

/** Mutable state the render loop reads. Kept off React so the loop is never rebuilt. */
interface LoopState {
  keys: Set<string>;
  hovering: boolean;
  up: Vec3;
  extent: number;
  fly: boolean;
  mode: ViewMode;
  pose: CameraPose | undefined;
  /** Pane width ÷ height, for fitting the recorded field of view into it. */
  aspect: number;
  /** How far the operator has turned from the recorded direction, radians. */
  look: { yaw: number; pitch: number };
  /** Frame the fixed camera is at or travelling to; null forces a fresh move. */
  appliedIndex: number | null;
  tween: { from: THREE.Vector3; quaternion: THREE.Quaternion; fov: number; startedAt: number } | null;
  dragging: boolean;
  /** The turntable. Null until a cloud exists to orbit. */
  cineScene: CinematicScene | null;
  cine: {
    /** Accumulated orbit angle, unbounded radians. */
    angle: number;
    /** The operator's own trim on the shot's elevation and radius. */
    elevation: number;
    zoom: number;
    /** When the operator last touched it, so the turn can hold and then ease back in. */
    lastInputAt: number;
  };
}

/** The status glyph, so the state survives greyscale — DESIGN.md's colour rule. */
const RESULT_GLYPH: Record<ResultKind, string> = {
  graded: "●",
  ungraded: "○",
  blind: "◐",
  refused: "▲",
  idle: "○",
};

/**
 * The measurement, in reserved chrome above the canvas.
 *
 * Reserved, not floating: it costs about 26 px of viewport and in exchange it can never sit in
 * front of the object being measured, whatever the scene is or wherever it has been orbited to.
 * That trade is the whole reason it exists — the readout it replaces was a translucent panel at
 * the top left, which is where the subject of a shot usually is.
 *
 * The wording is decided in `result-strip.ts`; this only lays it out.
 */
function ResultStrip({ readout }: { readout: ResultReadout }) {
  const graded = readout.kind === "graded";
  const quoting = graded || readout.kind === "ungraded" || readout.kind === "blind";
  return (
    <div className={`result-strip ${readout.kind}`}>
      <span className="result-glyph" aria-hidden>
        {RESULT_GLYPH[readout.kind]}
      </span>
      {readout.target && <span className="result-target">{readout.target}</span>}
      {quoting ? (
        <>
          <span className="result-basis">{readout.basis}</span>
          <b className="result-value">{readout.value}</b>
          <span className="result-pair">
            <i>tape</i>
            {readout.truth}
          </span>
          {graded && (
            <>
              <span className="result-pair">
                <i>error</i>
                {readout.error}
              </span>
              <span className="result-pair">
                <i>off by</i>
                {readout.errorPercent}
              </span>
            </>
          )}
          {readout.note && <span className="result-note">{readout.note}</span>}
        </>
      ) : (
        <span className="result-note">{readout.note}</span>
      )}
      <span className="spacer" />
      <HelpDot label="How this reading is graded">
        <p>
          <b>{"The measured value"}</b> is what the reconstruction says, straight from DA3, with no
          scale correction applied.
        </p>
        <p>
          <b>tape</b> is what you measured with a real tape and typed in against this target.{" "}
          <b>error</b> is the difference, and <b>off by</b> is that difference as a share of the
          truth.
        </p>
        <p>
          A target with no tape truth is measurable but ungradable — no error is quoted, because
          there is nothing to quote it against. Full uncertainty, repeat trials and the clip's
          scale bias are in the Objects pane.
        </p>
      </HelpDot>
    </div>
  );
}

export function Viewport3D() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene>(null);
  const controlsRef = useRef<OrbitControls>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const mountedRef = useRef<THREE.Object3D>(null);
  const evidenceRef = useRef<THREE.Group>(null);
  const pathRef = useRef<THREE.Group>(null);

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
  /**
   * DA3's GLB carries camera frustums beside the points, and this shows them.
   *
   * It used to be a one-of-N row — `Points | + Cameras` — which offered a choice this port cannot
   * make: the wire only ever carries points, so `Points` was the off position of a toggle wearing
   * a mode's clothes. One chip says the same thing with half the controls.
   */
  const [cameras, setCameras] = useState(false);
  const [layers, setLayers] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [mode, setMode] = useState<ViewMode>("free");
  const [fly, setFly] = useState(false);
  const [ghost, setGhost] = useState(false);
  const [ghostOpacity, setGhostOpacity] = useState(50);
  const [showKeys, setShowKeys] = useState(false);
  const [paneAspect, setPaneAspect] = useState(16 / 9);
  const [track, setTrack] = useState<CameraTrack | null>(null);
  const [trackError, setTrackError] = useState<string | null>(null);

  const advanced = useAdvanced();
  const graph = useGraph();
  const incoming = resolveInput(graph, VIEWER_3D_ID, "points");
  // The cloud itself carries no provenance — it is a GLB. Read it from the depth field that
  // produced it, one hop upstream, so the banner cannot disagree with what is rendered.
  const provenance = resolveInput(graph, "point-cloud", "depth")?.value as
    | DepthFieldValue
    | undefined;
  const cloud = incoming?.value as PointCloudValue | undefined;
  // Which cloud the switch is ASKING for, read from the node's own parameter rather than from
  // the rendered cloud. During a rebuild the two disagree for a second, and a chip that jumps
  // back to the old value while the new one loads reads as the click having failed.
  const cloudParams = graph.nodes.find((n) => n.id === POINT_CLOUD_ID)?.params;
  const requestedSource = (cloudParams?.source as CloudSource | undefined) ?? "glb";
  const requestedColour = (cloudParams?.colour as CloudColour | undefined) ?? "rgb";
  const requestedBudget = String(cloudParams?.budget ?? 1_000_000);
  const floor = useMemo(() => readFloorState(graph), [graph]);
  const ground = floor.kind === "ok" ? floor.ground : undefined;
  const selection = resolveCurrentInput(graph, VIEWER_3D_ID, "selection")?.value as SelectionValue | undefined;
  const measurement = resolveCurrentInput(graph, VIEWER_3D_ID, "measurement")?.value as MeasurementValue | undefined;

  // The frame slider lives in Depth 2D and publishes to the measurement store, so the two panes
  // are the same viewpoint at the same index without either knowing about the other.
  const ui = useMeasurementUi();
  const descriptor = provenance ? closestFrame(provenance, ui.canonicalFrame) : undefined;
  const pose = track && descriptor ? track.poses[descriptor.npzIndex] : undefined;
  const fixedRefused = track?.check.kind === "rejected" ? track.check.reason : null;
  const canRideCamera = Boolean(pose) && !fixedRefused;

  /**
   * Which way is up, from the best evidence available — and it matters more than it sounds.
   * DA3's scene is aligned to the FIRST CAMERA, so its +Y sits 33.2° from true up on the room
   * fixture. Walking along that would climb a third of a right angle while looking level.
   */
  const upAxis = useMemo(
    () =>
      resolveUpAxis({
        floorNormal: ground?.plane.normal,
        cameraUp: track?.gravity.up ?? ground?.gravity.up,
        coherence: track?.gravity.coherence ?? ground?.gravity.coherence,
      }),
    [ground, track],
  );

  const loopRef = useRef<LoopState>({
    keys: new Set(),
    hovering: false,
    up: [0, 1, 0],
    extent: 10,
    fly: false,
    mode: "free",
    pose: undefined,
    aspect: 16 / 9,
    look: { yaw: 0, pitch: 0 },
    appliedIndex: null,
    tween: null,
    dragging: false,
    cineScene: null,
    cine: { angle: 0, elevation: 0, zoom: 1, lastInputAt: 0 },
  });
  // Straight assignment rather than an effect, matching `pausedRef` above: the loop must see the
  // current values on its very next frame, not one render later.
  loopRef.current.up = upAxis.up;
  loopRef.current.extent = cloud?.extent ?? 10;
  loopRef.current.fly = fly;
  // Fixed is the only mode that can be refused — it needs a checked camera track. Cinematic
  // needs nothing but a cloud, and Free needs nothing at all.
  loopRef.current.mode = mode === "fixed" && !canRideCamera ? "free" : mode;
  loopRef.current.pose = pose;
  loopRef.current.aspect = paneAspect;

  /**
   * What Cinematic orbits.
   *
   * Centre and radius come from the cloud's own bounding box, so the shot frames whatever is
   * loaded rather than a size baked in here. `centerHeight` is what keeps the camera above the
   * floor: the centre of a bounding box is halfway up the room, and in a bad reconstruction it
   * can sit under the fitted plane entirely.
   */
  const cineScene = useMemo<CinematicScene | null>(() => {
    if (!cloud) return null;
    const center: Vec3 = [
      (cloud.bbox.min[0] + cloud.bbox.max[0]) / 2,
      (cloud.bbox.min[1] + cloud.bbox.max[1]) / 2,
      (cloud.bbox.min[2] + cloud.bbox.max[2]) / 2,
    ];
    return {
      center,
      up: upAxis.up,
      // 0.7 of the diagonal puts the whole cloud comfortably inside a 50° field of view without
      // shrinking it to a speck in the middle of an empty pane.
      radius: Math.max(0.5, cloud.extent * 0.7),
      centerHeight: ground ? signedHeight(ground.plane, center) : undefined,
    };
  }, [cloud, ground, upAxis.up]);
  loopRef.current.cineScene = cineScene;

  const toggleLayer = (id: string) =>
    setLayers((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /** Frame the whole cloud. The one action that always gets you back to a view you recognise. */
  const frameCloud = useCallback(() => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera || !cloud) return;
    const center = new THREE.Vector3(
      (cloud.bbox.min[0] + cloud.bbox.max[0]) / 2,
      (cloud.bbox.min[1] + cloud.bbox.max[1]) / 2,
      (cloud.bbox.min[2] + cloud.bbox.max[2]) / 2,
    );
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(0, -cloud.extent * 0.15, -cloud.extent * 0.6));
    camera.near = cloud.extent / 1000;
    camera.far = cloud.extent * 10;
    camera.fov = 50;
    camera.updateProjectionMatrix();
  }, [cloud]);

  /** In Fixed, the same key means "point me back where the camera pointed". */
  const recentre = useCallback(() => {
    if (loopRef.current.mode === "fixed") {
      loopRef.current.look = { yaw: 0, pitch: 0 };
      return;
    }
    frameCloud();
  }, [frameCloud]);

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
    const path = new THREE.Group();
    path.name = "camera-path";
    scene.add(path);
    pathRef.current = path;

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

    const forward = new THREE.Vector3();
    const offset = new THREE.Vector3();

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
      const elapsed = now - last;
      emaMs = emaMs * 0.95 + elapsed * 0.05;
      last = now;
      if (++tick % 30 === 0) setFrameMs(emaMs);

      const state = loopRef.current;
      // Clamped: a backgrounded tab resumes with a multi-second gap, and an unclamped step would
      // teleport a held key halfway across the scene before the operator could let go.
      const dt = Math.min(0.1, elapsed / 1000);
      camera.getWorldDirection(forward);
      const intent = navigationIntent(state.keys, {
        forward: [forward.x, forward.y, forward.z],
        up: state.up,
        dt,
        extent: state.extent,
        fly: state.fly,
      });

      if (state.mode === "cinematic" && state.cineScene) {
        rideTurntable(camera, state, now, dt);
      } else if (state.mode === "fixed" && state.pose) {
        if (intent.yaw !== 0 || intent.pitch !== 0) {
          state.look.yaw += intent.yaw;
          state.look.pitch = Math.min(
            LOOK_PITCH_LIMIT,
            Math.max(-LOOK_PITCH_LIMIT, state.look.pitch + intent.pitch),
          );
        }
        rideCamera(camera, state, now);
      } else {
        if (intent.active) walk(camera, controls, intent, state.up, offset);
        controls.update();
      }

      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setViewport(0, 0, w, h);
      renderer.setScissorTest(false);
      renderer.render(scene, camera);

      // Derived from the camera's own direction rather than from `controls.target`, which is
      // stale while the orbit controls are switched off in Fixed.
      camera.getWorldDirection(forward);
      gizmoCam.position.copy(forward).multiplyScalar(-3);
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
      setPaneAspect(w / h);
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
      pathRef.current = null;
      host.removeChild(renderer.domElement);
    };
  }, []);

  /**
   * Keyboard navigation, gated on the pointer being over this pane.
   *
   * Hover rather than click-to-focus: the point of these keys is to rescue a trackpad, and
   * demanding a click first — plus the focus ring DESIGN.md forbids — would put an obstacle in
   * front of the rescue. The typing guard is not optional: Objects has text fields, and the graph
   * binds Backspace, so a window-level listener that swallowed keys indiscriminately would break
   * both.
   */
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

    const onKeyDown = (event: KeyboardEvent) => {
      const state = loopRef.current;
      if (!state.hovering || typing(event.target) || event.metaKey || event.ctrlKey) return;
      const key = navigationKeyFor(event.code, event.key);
      if (!key) return;
      if (key === "f") {
        event.preventDefault();
        recentre();
        return;
      }
      // Arrows scroll the page and WASD can reach other handlers; both would fight the viewport.
      if (NAVIGATION_KEYS.has(key)) event.preventDefault();
      state.keys.add(key);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = navigationKeyFor(event.code, event.key);
      if (key) loopRef.current.keys.delete(key);
    };
    // A key held while the window loses focus never sends its release, so it would stick down.
    const release = () => loopRef.current.keys.clear();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
    };
  }, [recentre]);

  /**
   * Hand the camera between the orbit controls and the recorded pose.
   *
   * Keyed on the TRANSITION, not on the current mode. This effect also runs when the camera track
   * finishes loading — `canRideCamera` flips then — and an earlier version treated that as
   * "leaving Fixed" and moved the orbit pivot to wherever the camera happened to face. On a fresh
   * load that fired before the controls had aimed the camera at the cloud, so the pivot went
   * behind it and the pane opened on empty space with a point cloud sitting off screen.
   */
  const previousModeRef = useRef<ViewMode>("free");
  useEffect(() => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const state = loopRef.current;
    if (!controls || !camera) return;

    const wasFixed = previousModeRef.current === "fixed";
    const wasCinematic = previousModeRef.current === "cinematic";
    previousModeRef.current = state.mode;

    if (state.mode === "fixed") {
      // Orbit moves the camera, which is the one thing Fixed promises not to do.
      controls.enabled = false;
      state.look = { yaw: 0, pitch: 0 };
      state.appliedIndex = null;
      return;
    }

    if (state.mode === "cinematic") {
      // Same reason as Fixed: two things driving one camera fight, and the orbit controls would
      // win on the frames where damping is still settling.
      controls.enabled = false;
      state.tween = null;
      // Start from where the camera already is, so entering the mode is a turn rather than a cut
      // to the far side of the scene. The trim resets — it belongs to a shot, not to the pane.
      state.cine = {
        angle: state.cineScene
          ? angleFacing(state.cineScene, [
              camera.position.x,
              camera.position.y,
              camera.position.z,
            ])
          : 0,
        elevation: 0,
        zoom: 1,
        // Dated now, so the shot eases up to speed instead of starting at full rate.
        lastInputAt: performance.now(),
      };
      // Fixed leaves the recorded field of view behind on the camera; the turntable is framed for
      // 50° and would be wrong at 38°.
      camera.fov = 50;
      camera.updateProjectionMatrix();
      return;
    }

    /*
      Leaving Cinematic hands the orbit pivot the scene centre the turntable was circling, so the
      first drag continues the same motion instead of swinging around a stale target. Guarded on
      the transition, like everything else in this effect: `canRideCamera` flips when the camera
      track finishes loading, and an unguarded reset here would yank the pivot out from under
      somebody who had already orbited somewhere.

      The up vector goes back to the scene's +Y because that is the axis Free has always orbited
      about. Cinematic needs the measured up — it is drawing a level circle — but changing Free's
      orbit axis is a different decision and not one this task is making.
    */
    if (wasCinematic) {
      if (state.cineScene) controls.target.set(...state.cineScene.center);
      camera.up.set(0, 1, 0);
    }
    controls.enabled = true;
    state.tween = null;
    state.appliedIndex = null;
    if (!wasFixed) return;

    // Leaving Fixed, put the pivot where the operator was looking, at a distance that makes the
    // first orbit feel like a continuation rather than a jump to somewhere else.
    const ahead = new THREE.Vector3();
    camera.getWorldDirection(ahead);
    controls.target.copy(camera.position).addScaledVector(ahead, Math.max(0.5, state.extent * 0.25));
    camera.fov = 50;
    camera.updateProjectionMatrix();
  }, [mode, canRideCamera]);

  // Swap in whatever the wire is carrying. The PointCloud node already did the
  // loading, decimation and coloring, so this is a scene-graph swap, not a parse.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (mountedRef.current) {
      const retired = mountedRef.current;
      scene.remove(retired);
      mountedRef.current = null;
      if (retired !== cloud?.object) disposeSubtree(retired);
    }
    if (!cloud) return;

    scene.add(cloud.object);
    mountedRef.current = cloud.object;
    frameCloud();
  }, [cloud, frameCloud]);

  /**
   * Recover the camera poses, and check them against the scene file before believing them.
   *
   * `worldFromDa3` falls back to the identity for a GLB carrying no alignment, which is harmless
   * everywhere else and would put the fixed camera confidently in the wrong place here. The check
   * costs nothing — the frustums are already loaded — and the refusal it produces is reported
   * rather than swallowed.
   */
  useEffect(() => {
    let cancelled = false;
    setTrack(null);
    setTrackError(null);
    if (!cloud || !provenance) return;

    provenance
      .loadArrays()
      .then((arrays) => {
        if (cancelled) return;
        const { depth, extrinsics, intrinsics } = arrays;
        if (!depth || !extrinsics || !intrinsics) {
          throw new Error("this run's result file carries no camera poses");
        }
        const [, height, width] = depth.shape;
        setTrack(
          cameraTrack(
            {
              extrinsics: extrinsics.data,
              intrinsics: intrinsics.data,
              imageWidth: width,
              imageHeight: height,
              worldFromDa3: cloud.worldFromDa3,
            },
            cloud.object,
            cloud.extent,
          ),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setTrackError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [cloud, provenance]);

  // A replacement cloud temporarily has no checked camera track. Keep the operator's requested
  // mode through that gap; only a completed check that actually refused the pose returns to Free.
  useEffect(() => {
    if (mode === "fixed" && (fixedRefused || trackError)) setMode("free");
  }, [mode, fixedRefused, trackError]);

  const showFloorPlane = layers.has(FLOOR_PLANE_LAYER);
  const showFloorPoints = layers.has(FLOOR_POINTS_LAYER);
  const showUpAxes = layers.has(FLOOR_UP_LAYER);
  const showBelow = layers.has(BELOW_PLANE_LAYER);
  const showCameraPath = layers.has(CAMERA_PATH_LAYER);

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
      const below = collectPointsBelow(cloud.measurementPositions, ground.plane);
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

  /**
   * The camera's route, and where it was for the frame on screen.
   *
   * Its own group rather than part of the evidence one because it changes on every step of the
   * frame slider, and rebuilding a 350k-point below-plane layer at that rate would stutter.
   */
  useEffect(() => {
    const group = pathRef.current;
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      disposeSubtree(child);
    }
    if (!track || !showCameraPath || !cloud) return;

    const vertices = new Float32Array(track.poses.length * 3);
    track.poses.forEach((item, index) => vertices.set(item.position, index * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    // Drawn THROUGH the cloud, like the ruler and the selection above. A route that is occluded
    // by the very scene it walked through is invisible exactly when it is most useful — the
    // camera spends most of a walkthrough behind something.
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        color: CAMERA_HUE,
        transparent: true,
        opacity: 0.6,
        depthTest: false,
      }),
    );
    line.renderOrder = 3;
    line.name = "camera-route";
    group.add(line);

    if (!pose) return;
    const markerRadius = Math.max(0.01, cloud.extent / 220);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(markerRadius, 12, 8),
      new THREE.MeshBasicMaterial({ color: CAMERA_HUE, depthTest: false }),
    );
    marker.position.set(...pose.position);
    marker.renderOrder = 4;
    marker.name = "camera-here";
    group.add(marker);

    // Aimed, not just marked: which way a frame looked is the half that says what it could see.
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(...pose.forward).normalize(),
      new THREE.Vector3(...pose.position),
      Math.max(0.15, cloud.extent * 0.08),
      CAMERA_HUE,
    );
    arrow.name = "camera-aim";
    // ArrowHelper is a Line plus a Mesh with their own materials, so the flag has to reach both.
    arrow.traverse((child) => {
      const material = (child as Partial<THREE.Mesh>).material;
      for (const item of Array.isArray(material) ? material : material ? [material] : []) {
        item.depthTest = false;
      }
      child.renderOrder = 4;
    });
    group.add(arrow);
  }, [track, pose, showCameraPath, cloud]);

  // DA3's GLB carries camera frustums alongside the points; the chip toggles them.
  // Only the frustum geometry itself may be hidden — toggling every non-Points object
  // would also hide the groups the points hang off, blanking the whole scene.
  useEffect(() => {
    if (!cloud) return;
    cloud.object.traverse((child) => {
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.visible = cameras;
      }
    });
  }, [cloud, cameras]);

  /**
   * Standard turns the layers off; it does not merely hide their chips.
   *
   * Hiding the switch for something the pane is still drawing leaves an effect with no way out —
   * an amber below-plane cloud over the scene and nothing on screen that could remove it. This is
   * the rule in `lib/ui-mode.ts` applied to the one pane that has state to strand.
   */
  useEffect(() => {
    if (advanced) return;
    setLayers((previous) => (previous.size === 0 ? previous : new Set<string>()));
  }, [advanced]);

  const status = useMemo(() => {
    if (!cloud) return "no input";
    return `${cloud.pointCount.toLocaleString()} pts`;
  }, [cloud]);

  const riding = mode === "fixed" && canRideCamera && pose;
  const frameRect = riding && pose ? recordedFrameRect(pose, paneAspect) : null;
  const cameraHeight =
    riding && pose && ground ? signedHeight(ground.plane, pose.position) : null;

  /**
   * The headline, decided in `result-strip.ts` where its honesty rules can be tested.
   *
   * The target comes from the measurement store rather than from the wire, because the wire
   * carries a measurement and not the tape truth it should be graded against — and a reading with
   * no truth beside it is exactly the thing this strip exists to stop being ambiguous.
   */
  const target = activeMeasurementObject();
  const result = useMemo(
    () =>
      describeResult({
        floor,
        measurement,
        target: target
          ? { code: target.code, name: target.name, truthM: target.truthM }
          : undefined,
        blind: ui.blind,
      }),
    [floor, measurement, target, ui.blind],
  );

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
      {/*
        The one row Standard has, and it answers one question: where am I standing.

        `Cameras` rides along because it is a property of what is drawn rather than of the view,
        and it is the only such switch a person looking at a reconstruction reaches for. Everything
        else that used to sit in these rows configures how the cloud was BUILT or draws evidence
        about the ground fit, and both are debugging.
      */}
      <OutputRow
        label="VIEW"
        choices={VIEW_MODES}
        active={mode}
        onSelect={(id) => setMode(id as ViewMode)}
        /*
          Short, and permanent. A control nobody knows about is not a control: WASD was reachable
          only by first clicking `Keys`, which is a thing you click once you already suspect the
          keys exist. Dropped in Fixed, where the row also carries the ghost controls and a hint
          costs a whole extra line of chrome — 136 px of a 450 px pane, measured — and in
          Cinematic, which says what its keys do in the shot itself.
        */
        hint={mode === "free" ? "WASD move · arrows look" : undefined}
        extra={
          <>
            <button
              className={`chip-toggle${cameras ? " on" : ""}`}
              aria-pressed={cameras}
              title="Show the camera frustums DA3 exported beside the points — one per frame, where the camera was and what it could see."
              onClick={() => setCameras((value) => !value)}
            >
              Cameras
            </button>
            {advanced && (
              <>
                <button
                  className={`chip-toggle${fly ? " on" : ""}`}
                  aria-pressed={fly}
                  title="Walk keeps W level with the ground, so a glance downwards cannot bury you in the floor. Fly follows wherever you are looking."
                  onClick={() => setFly((value) => !value)}
                >
                  {fly ? "Fly" : "Walk"}
                </button>
                <button
                  className={`chip-toggle${showKeys ? " on" : ""}`}
                  aria-pressed={showKeys}
                  title="Show every mouse and keyboard control this pane has"
                  onClick={() => setShowKeys((value) => !value)}
                >
                  Keys
                </button>
              </>
            )}
            {advanced && mode === "fixed" && (
              <>
                <button
                  className={`chip-toggle${ghost ? " on" : ""}`}
                  aria-pressed={ghost}
                  title="Lay the real video frame over the reconstruction from the same viewpoint. Where they disagree, the geometry is wrong — bear in mind the cloud was built from these same frames, so agreement is partly guaranteed."
                  onClick={() => setGhost((value) => !value)}
                >
                  Video ghost
                </button>
                {ghost && (
                  <>
                    <input
                      aria-label="Video ghost opacity"
                      type="range"
                      min="10"
                      max="100"
                      step="5"
                      value={ghostOpacity}
                      onChange={(event) => setGhostOpacity(Number(event.target.value))}
                    />
                    <span className="mono">{ghostOpacity}%</span>
                  </>
                )}
              </>
            )}
          </>
        }
      />
      {advanced && (
        <>
          {/*
            Which cloud is being measured, switchable from the pane that shows it.
            It is a parameter of the Point Cloud node, and it is still editable there — but the
            node lives in a graph pane the measurement layout keeps small, and a switch you have to
            go and find is a switch nobody A/Bs. The hint carries the number that makes the two
            clouds different: the share of its own pixels that the LEANEST frame contributed.
          */}
          <OutputRow
            label="CLOUD"
            choices={CLOUD_SOURCES}
            active={requestedSource}
            onSelect={(id) => setNodeParamAndRun(POINT_CLOUD_ID, "source", id)}
            hint={
              cloud?.leanestFrameShare == null
                ? undefined
                : `leanest frame ${(cloud.leanestFrameShare * 100).toFixed(0)}%`
            }
          />
          {/*
            Colour and budget belong to the rebuilt cloud only. DA3's export carries its own vertex
            colours and its own fixed 1,000,000, so offering either against it would be a control
            that does nothing — the failure DESIGN.md calls a lie in the interface.

            The budget hint is the share of finite, non-edge display candidates it kept. Confidence
            stays on the separate measurement cloud and does not erase the picture.
          */}
          {requestedSource === "npz" && (
            <>
              <OutputRow
                label="COLOUR"
                choices={CLOUD_COLOURS}
                active={requestedColour}
                onSelect={(id) => setNodeParamAndRun(POINT_CLOUD_ID, "colour", id)}
                hint={cloud?.coloured === false ? "no frames on disk — ramped" : undefined}
              />
              <OutputRow
                label="POINTS"
                choices={CLOUD_BUDGETS}
                active={requestedBudget}
                onSelect={(id) => setNodeParamAndRun(POINT_CLOUD_ID, "budget", Number(id))}
                hint={
                  cloud?.keptOfCandidates == null
                    ? undefined
                    : `${(cloud.keptOfCandidates * 100).toFixed(0)}% of finite candidates`
                }
              />
            </>
          )}
          <LayerRow choices={LAYERS} active={layers} onToggle={toggleLayer} />
        </>
      )}
      <ResultStrip readout={result} />
      <ProvenanceBanner field={provenance} />
      <div
        className="pane-body"
        ref={hostRef}
        onPointerEnter={() => {
          loopRef.current.hovering = true;
        }}
        onPointerLeave={() => {
          loopRef.current.hovering = false;
          // Otherwise a key held on the way out never sees its release and sticks down.
          loopRef.current.keys.clear();
          loopRef.current.dragging = false;
        }}
        onPointerDown={(event) => {
          const state = loopRef.current;
          if (state.mode !== "fixed" && state.mode !== "cinematic") return;
          state.dragging = true;
          if (state.mode === "cinematic") state.cine.lastInputAt = performance.now();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const state = loopRef.current;
          if (!state.dragging) return;
          const height = event.currentTarget.clientHeight || 1;
          // A full turn per screen height, matching what the orbit controls do in Free, and in
          // the same direction: dragging right slides the scene right, so the view turns left.
          const rate = (2 * Math.PI) / height;
          if (state.mode === "cinematic") {
            // The drag steers the shot rather than leaving the mode: it feeds the same angle and
            // elevation the turn itself advances, so letting go resumes from where you left it
            // instead of snapping back to a path you have been dragged off.
            state.cine.angle += event.movementX * rate;
            state.cine.elevation = Math.min(
              CINE_PITCH_LIMIT,
              Math.max(-CINE_PITCH_LIMIT, state.cine.elevation + event.movementY * rate),
            );
            state.cine.lastInputAt = performance.now();
            return;
          }
          if (state.mode !== "fixed") return;
          state.look.yaw += event.movementX * rate;
          state.look.pitch = Math.min(
            LOOK_PITCH_LIMIT,
            Math.max(-LOOK_PITCH_LIMIT, state.look.pitch - event.movementY * rate),
          );
        }}
        onPointerUp={(event) => {
          const state = loopRef.current;
          state.dragging = false;
          if (state.mode === "cinematic") state.cine.lastInputAt = performance.now();
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onWheel={(event) => {
          // Cinematic has the orbit controls switched off, so the wheel would otherwise do
          // nothing at all — and a dead wheel over a 3D scene reads as a broken pane.
          const state = loopRef.current;
          if (state.mode !== "cinematic") return;
          const [low, high] = CINE_ZOOM_RANGE;
          state.cine.zoom = Math.min(
            high,
            Math.max(low, state.cine.zoom * Math.exp(event.deltaY * 0.0015)),
          );
          state.cine.lastInputAt = performance.now();
        }}
      >
        {frameRect && (
          // Exactly the rectangle the recorded frame occupies, so the ghost and the boundary
          // marker cannot claim an alignment they do not have.
          <div
            className="recorded-frame"
            style={{
              width: `${frameRect.widthFraction * 100}%`,
              height: `${frameRect.heightFraction * 100}%`,
            }}
          >
            {ghost && descriptor && (
              <img
                className="recorded-ghost"
                src={descriptor.rgbUrl}
                alt=""
                style={{ opacity: ghostOpacity / 100 }}
              />
            )}
          </div>
        )}
        {/*
          Advanced only, and that is the whole point of the result strip above.

          This block is how the fit gets debugged and it sits over the scene, which is where the
          thing being measured is. In Standard the strip carries what the run says and how wrong it
          is, in reserved chrome that cannot occlude anything; here the diagnostics come back, in
          full, for the pass where you are asking about the plane rather than about the object.
        */}
        {cloud && advanced && (
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
                FLOOR {(floor.ground.fit.inlierFraction * 100).toFixed(1)}% SUPPORT · {(floor.ground.fit.belowFraction * 100).toFixed(1)}% BELOW · {floor.ground.fit.tiltDeg.toFixed(1)}° TILT
                {/*
                  A clamped tilt is the plane the GATE allowed, not the plane the points wanted.
                  Saying so here is the whole point of bounding it: an operator who tightens the
                  limit and sees the number obey has learned nothing unless they can also see when
                  obedience cost them the better-fitting plane.
                */}
                {floor.ground.fit.tiltClamped && <> (GATED)</>} · {(floor.ground.fit.rmse * 100).toFixed(1)} cm RMSE
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
            {/*
              Which vertical the keys are walking along. Never silent, because "up" here is
              evidence rather than a convention, and a scene whose up is a guess navigates
              differently from one whose up was measured.
            */}
            {floor.kind !== "absent" || measurement ? <br /> : null}
            {riding && pose ? (
              <>
                FIXED · FRAME {descriptor?.canonicalIndex ?? "—"} · {pose.vfovDeg.toFixed(1)}° VFOV
                {cameraHeight !== null && <> · {cameraHeight.toFixed(2)} m ABOVE FLOOR</>}
                <br />
                <span className="overlay-dim">drag or arrows to look · WASD off · F re-aims</span>
              </>
            ) : mode === "cinematic" ? (
              <>
                CINEMATIC · {ORBIT_RATE_DEG_S}°/s · UP FROM{" "}
                {upAxis.source === "floor"
                  ? "FITTED FLOOR"
                  : upAxis.source === "camera"
                    ? "CAMERA PATH"
                    : "SCENE +Y (UNMEASURED)"}
                <br />
                <span className="overlay-dim">drag or A D to turn · W S in and out · resumes on its own</span>
              </>
            ) : (
              <>
                FREE · {fly ? "FLY" : "WALK"} · UP FROM{" "}
                {upAxis.source === "floor"
                  ? "FITTED FLOOR"
                  : upAxis.source === "camera"
                    ? "CAMERA PATH"
                    : "SCENE +Y (UNMEASURED)"}
              </>
            )}
            {fixedRefused && (
              <>
                <br />
                <span className="overlay-failed">▲ NO FIXED VIEW — {fixedRefused}</span>
              </>
            )}
            {trackError && (
              <>
                <br />
                <span className="overlay-failed">▲ NO CAMERA TRACK — {trackError}</span>
              </>
            )}
          </div>
        )}
        {showKeys && advanced && (
          <div className="key-help">
            <b>Move</b> W A S D · <b>Up/down</b> E Q · <b>Look</b> arrows or drag
            <br />
            <b>Faster</b> Shift · <b>Finer</b> Alt · <b>Zoom</b> wheel
            <br />
            <b>F</b> {riding ? "re-aim at the recorded direction" : "frame the whole cloud"}
            <br />
            <span className="overlay-dim">
              Keys act while the pointer is over this pane. Movement is off in Fixed, which is what
              keeps the viewpoint the camera's own.
            </span>
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

/**
 * Move the whole rig — camera and pivot together.
 *
 * Translating both is what lets orbit survive navigation: the spherical offset between them is
 * untouched, so a drag after a walk orbits around the thing you walked up to rather than snapping
 * back to where the pivot used to be. Look is applied as a rotation of that same offset, which is
 * the keyboard's version of exactly what a left-drag does.
 */
function walk(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  intent: ReturnType<typeof navigationIntent>,
  up: Vec3,
  scratch: THREE.Vector3,
): void {
  const offset = scratch.copy(camera.position).sub(controls.target);
  const radius = offset.length();
  if (radius > 1e-6 && (intent.yaw !== 0 || intent.pitch !== 0)) {
    let direction: Vec3 = [-offset.x / radius, -offset.y / radius, -offset.z / radius];
    if (intent.yaw !== 0) direction = rotateAbout(direction, up, intent.yaw);
    if (intent.pitch !== 0) {
      const right = normalize(cross(direction, up));
      if (right) {
        const polar = Math.acos(Math.min(1, Math.max(-1, dot(direction, up))));
        const applied = clampPitch(polar, intent.pitch);
        if (applied !== 0) direction = rotateAbout(direction, right, applied);
      }
    }
    camera.position.set(
      controls.target.x - direction[0] * radius,
      controls.target.y - direction[1] * radius,
      controls.target.z - direction[2] * radius,
    );
  }

  const [dx, dy, dz] = intent.move;
  if (dx !== 0 || dy !== 0 || dz !== 0) {
    camera.position.x += dx;
    camera.position.y += dy;
    camera.position.z += dz;
    controls.target.x += dx;
    controls.target.y += dy;
    controls.target.z += dz;
  }
}

/**
 * Turn the scene by itself, and let the operator trim the shot without leaving the mode.
 *
 * The angle accumulates here rather than being derived from a clock, which is what lets the turn
 * hold still while somebody is dragging and then ease back in: the rate is scaled by
 * `rateFactor`, and a paused turn simply adds nothing. Deriving the angle from elapsed time would
 * make every pause a jump, because time keeps running whether or not the shot does.
 *
 * Steering is deliberately coarser than Free's. This is framing a shot, not travelling through a
 * scene, and Free's rates — tuned so a held key crosses the cloud in five seconds — overshoot
 * badly when what you want is ten degrees to the left.
 */
function rideTurntable(
  camera: THREE.PerspectiveCamera,
  state: LoopState,
  now: number,
  dt: number,
): void {
  const scene = state.cineScene;
  if (!scene) return;
  const cine = state.cine;
  const held = (...names: string[]) => names.some((name) => state.keys.has(name));

  let steered = false;
  const yaw = (held("a", "arrowleft") ? 1 : 0) - (held("d", "arrowright") ? 1 : 0);
  if (yaw !== 0) {
    cine.angle += yaw * CINE_KEY_YAW * dt;
    steered = true;
  }
  const pitch = (held("arrowup", "e") ? 1 : 0) - (held("arrowdown", "q") ? 1 : 0);
  if (pitch !== 0) {
    cine.elevation = clampRange(cine.elevation + pitch * CINE_KEY_PITCH * dt, -CINE_PITCH_LIMIT, CINE_PITCH_LIMIT);
    steered = true;
  }
  const dolly = (held("s") ? 1 : 0) - (held("w") ? 1 : 0);
  if (dolly !== 0) {
    // Multiplicative, so a step feels the same size whether you are near the cloud or far from
    // it — the same reason Free scales its speed by the scene's extent.
    cine.zoom = clampRange(cine.zoom * Math.exp(dolly * CINE_KEY_ZOOM * dt), ...CINE_ZOOM_RANGE);
    steered = true;
  }
  if (steered) cine.lastInputAt = now;

  cine.angle += (ORBIT_RATE_DEG_S * Math.PI) / 180 * dt * rateFactor(now - cine.lastInputAt);

  const pose = cinematicPose(scene, cine.angle, cine.elevation, cine.zoom);
  camera.position.set(...pose.position);
  // Set before `lookAt`, which reads it to decide which way the horizon lies. Without this the
  // shot rolls whenever the measured up is not the scene's +Y — which is most of the time, since
  // DA3 aligns its scene to the first camera.
  camera.up.set(...state.up);
  camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
}

function clampRange(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Put the camera where the recording camera was, easing between frames.
 *
 * The measured step between consecutive frames is a median 5–31 cm and up to 14° of turn, so
 * snapping reads as a glitch rather than as movement. The eased travel is short enough that
 * scrubbing still feels immediate, and the look offset keeps applying throughout it — turning
 * your head mid-step should not be interrupted by the step.
 */
function rideCamera(camera: THREE.PerspectiveCamera, state: LoopState, now: number): void {
  const pose = state.pose;
  if (!pose) return;

  const target = new THREE.Vector3(...pose.position);
  const orientation = aimedOrientation(pose, state.up, state.look.yaw, state.look.pitch);
  const fov = fitFovDeg(pose, state.aspect);

  if (state.appliedIndex !== pose.npzIndex) {
    state.appliedIndex = pose.npzIndex;
    state.tween = {
      from: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      fov: camera.fov,
      startedAt: now,
    };
  }

  if (state.tween) {
    const t = ease((now - state.tween.startedAt) / POSE_TWEEN_MS);
    camera.position.lerpVectors(state.tween.from, target, t);
    camera.quaternion.slerpQuaternions(state.tween.quaternion, orientation, t);
    camera.fov = state.tween.fov + (fov - state.tween.fov) * t;
    camera.updateProjectionMatrix();
    if (t >= 1) state.tween = null;
    return;
  }

  camera.position.copy(target);
  camera.quaternion.copy(orientation);
  if (Math.abs(camera.fov - fov) > 1e-4) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}
