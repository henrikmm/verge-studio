import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

const GIZMO_PX = 72;

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

    const loader = new PLYLoader();
    loader.load(
      "/roadside/canonical-preview.ply",
      (geometry) => {
        geometry.computeBoundingBox();
        const bbox = geometry.boundingBox!;
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3()).length();
        const material = new THREE.PointsMaterial({
          size: size / 800,
          vertexColors: geometry.hasAttribute("color"),
          sizeAttenuation: true,
        });
        scene.add(new THREE.Points(geometry, material));
        controls.target.copy(center);
        camera.position.copy(center).add(new THREE.Vector3(0, -size * 0.15, -size * 0.6));
        camera.near = size / 1000;
        camera.far = size * 10;
        camera.updateProjectionMatrix();
        setPoints(geometry.getAttribute("position").count);
      },
      undefined,
      (err) => setError(err instanceof Error ? err.message : "PLY load failed"),
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
