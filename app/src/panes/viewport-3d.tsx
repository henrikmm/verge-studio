import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const GIZMO_PX = 72;

// Fallback for colorless clouds: turbo-ish ramp along world height (z-up in DA3 world frame).
function colorByHeight(geometry: THREE.BufferGeometry) {
  const pos = geometry.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z < min) min = z;
    if (z > max) max = z;
  }
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getZ(i) - min) / (max - min || 1);
    c.setHSL(0.66 - 0.66 * t, 0.85, 0.55);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

export function Viewport3D() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState(0);
  const [frameMs, setFrameMs] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0a0a0c");
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    camera.position.set(0, 0, 10);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // Corner axes gizmo: separate scene, camera mirrors the main orbit rotation.
    const gizmoScene = new THREE.Scene();
    gizmoScene.add(new THREE.AxesHelper(1));
    const gizmoCam = new THREE.PerspectiveCamera(40, 1, 0.1, 10);

    // DA3-native export: colored point cloud + camera frustums (see docs/SOURCES.md).
    const loader = new GLTFLoader();
    loader.load(
      "/roadside/scene.glb",
      (gltf) => {
        const bbox = new THREE.Box3().setFromObject(gltf.scene);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3()).length();
        let count = 0;
        gltf.scene.traverse((obj) => {
          if (obj instanceof THREE.Points) {
            const geometry = obj.geometry;
            count += geometry.getAttribute("position").count;
            if (!geometry.hasAttribute("color")) colorByHeight(geometry);
            obj.material = new THREE.PointsMaterial({
              size: size / 800,
              vertexColors: true,
              sizeAttenuation: true,
            });
          }
        });
        scene.add(gltf.scene);
        controls.target.copy(center);
        camera.position.copy(center).add(new THREE.Vector3(0, -size * 0.15, -size * 0.6));
        camera.near = size / 1000;
        camera.far = size * 10;
        camera.updateProjectionMatrix();
        setPoints(count);
      },
      undefined,
      (err) => setError(err instanceof Error ? err.message : "GLB load failed"),
    );

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

      // gizmo overlay bottom-right
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

  return (
    <div className="pane">
      <div className="pane-status">
        {error ? (
          <span style={{ color: "var(--accent-err)" }}>{error}</span>
        ) : (
          <>
            <span className="ok">{points.toLocaleString()} pts</span>
            <span>{frameMs.toFixed(1)} ms</span>
          </>
        )}
        <span className="hint">Left-drag orbit · wheel zoom · right-drag pan</span>
      </div>
      <div className="pane-body" ref={hostRef} />
    </div>
  );
}
