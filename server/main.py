"""DA3 inference service — Cloud Run Service, 1x NVIDIA L4, scale-to-zero.

Design notes that matter:

* Inference runs in a thread executor and is guarded by a lock, so exactly one run
  happens at a time while `/gpu` stays responsive. That is what makes the app's live
  VRAM readout possible — Cloud Run must therefore be deployed with concurrency > 1
  even though only one inference executes at once.
* Frames arrive already extracted. The Mac does ffmpeg (local-first); the server
  never resamples and never downloads video.
* Artifacts go to GCS when `VERGE_OUTPUT_BUCKET` is set, otherwise they stay on
  local disk and are served from `/artifact`. The mock server uses the same shape.
* Transience is enforced here, not left to chance. Uploaded frames are discarded the
  moment inference returns, and run directories are swept once they pass
  `VERGE_RUN_TTL_SECONDS`. Before 2026-08-06 nothing deleted a successful run at all --
  the instance dying was the only cleanup, which made the "nothing is kept unless the
  user saves it" policy an accident of scheduling rather than a property of the service.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from contract import (
    Artifact,
    Diagnostics,
    FrameInfo,
    GpuSnapshot,
    HealthResponse,
    InferManifest,
    InferParams,
    Timing,
    VramStats,
    WarmupResponse,
)
import vram

MODEL_DIR = os.environ.get("VERGE_MODEL_DIR", "/opt/mvl-models/da3_nested_giant_large_1_1")
OUTPUT_BUCKET = os.environ.get("VERGE_OUTPUT_BUCKET", "")
OUTPUT_PREFIX = os.environ.get("VERGE_OUTPUT_PREFIX", "runs/transient").strip("/")
RUN_ROOT = Path(os.environ.get("VERGE_RUN_ROOT", tempfile.gettempdir())) / "verge-runs"

# How long a finished run's exports stay fetchable on this instance.
#
# Generous on purpose. A batched session runs several experiments against one warm machine
# and saves them at the end, so a short window would delete artifacts the user has already
# paid for but not yet fetched. Six hours outlives any session we have run while still
# bounding growth on an instance that --min-instances=1 keeps alive indefinitely.
#
# This bounds LOCAL disk only. Durable storage expiry is the bucket's lifecycle rule; see
# expires_after_days in contract.py.
RUN_TTL_SECONDS = int(os.environ.get("VERGE_RUN_TTL_SECONDS", 6 * 60 * 60))

app = FastAPI(title="Verge Studio DA3 service")

# The app is served from localhost during development; the service is identity-token
# protected, so permissive CORS here does not widen access.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_model: Any = None
_model_load_seconds: float | None = None
_infer_lock = asyncio.Lock()
_busy = False
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="da3")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_model() -> Any:
    """Blocking. ~6.7 GB checkpoint; this is the bulk of the ~3 min cold start."""
    global _model, _model_load_seconds
    if _model is not None:
        return _model
    from depth_anything_3.api import DepthAnything3

    started = time.monotonic()
    model = DepthAnything3.from_pretrained(MODEL_DIR).to("cuda")
    _model_load_seconds = time.monotonic() - started
    _model = model
    return _model


def _snapshot() -> GpuSnapshot:
    stats = vram.current_snapshot()
    return GpuSnapshot(
        available=vram.cuda_available(),
        model_loaded=_model is not None,
        busy=_busy,
        device_name=str(stats["device_name"]),
        current_bytes=int(stats["current_bytes"]),
        peak_bytes=int(stats["peak_bytes"]),
        total_bytes=int(stats["total_bytes"]) or GpuSnapshot.model_fields["total_bytes"].default,
    )


# NOT /healthz: Google's frontend swallows that path on Cloud Run and returns its own
# HTML 404 before the request ever reaches the container. Verified 2026-07-31 — /gpu,
# /docs and /openapi.json all served fine from the same revision while /healthz 404'd.
@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        model_loaded=_model is not None,
        gpu_available=vram.cuda_available(),
    )


@app.get("/gpu", response_model=GpuSnapshot)
def gpu() -> GpuSnapshot:
    """Polled by the UI during inference for the live VRAM bar."""
    return _snapshot()


@app.post("/warmup", response_model=WarmupResponse)
async def warmup() -> WarmupResponse:
    if not vram.cuda_available():
        raise HTTPException(status_code=503, detail="no CUDA device")
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(_executor, _load_model)
    return WarmupResponse(
        model_loaded=True,
        model_load_seconds=_model_load_seconds or 0.0,
        gpu=_snapshot(),
    )


def _run_inference(frame_paths: list[str], params: InferParams, export_dir: Path) -> dict[str, Any]:
    """Blocking; runs on the executor thread."""
    model = _load_model()

    export_formats = ["npz", "glb"]
    if params.infer_gs:
        export_formats += ["gs_ply"]

    started = time.monotonic()
    with vram.VramSampler() as sampler:
        prediction = model.inference(
            frame_paths,
            process_res=params.process_res,
            process_res_method=params.process_res_method,
            ref_view_strategy=params.ref_view_strategy,
            infer_gs=params.infer_gs,
            export_dir=str(export_dir),
            export_format="-".join(export_formats),
        )
    gpu_seconds = time.monotonic() - started

    import numpy as np

    # Written as verge-result.npz, NOT result.npz. DA3's own `npz` exporter writes into
    # this same export_dir, and if it picks the name result.npz ours silently overwrites
    # it -- taking DA3's embedded images and any keys we do not re-emit with it. A
    # distinct filename makes the two coexist whatever DA3 chooses to call its own.
    # The keys below are the ones app/src/lib/npz.ts reads; see native_npz in the
    # manifest for what DA3 emitted alongside.
    ours = export_dir / VERGE_NPZ_NAME
    np.savez_compressed(
        ours,
        depth=prediction.depth,
        confidence=prediction.conf,
        extrinsics=prediction.extrinsics,
        intrinsics=prediction.intrinsics,
    )

    # Record what DA3 itself produced, so the npz key names stop being a guess. This is
    # cheap (a directory listing plus one npz header read) and answers the open question
    # without another cloud session.
    native_npz: dict[str, list[str]] = {}
    for path in sorted(export_dir.glob("*.npz")):
        if path.name == ours.name:
            continue
        try:
            with np.load(path, allow_pickle=False) as handle:
                native_npz[path.name] = list(handle.files)
        except Exception as exc:  # a listing must never fail the run
            native_npz[path.name] = [f"<unreadable: {exc}>"]

    depth = np.asarray(prediction.depth)
    return {
        "gpu_seconds": gpu_seconds,
        "peak_bytes": sampler.peak_bytes,
        "torch_peak_bytes": sampler.torch_peak_bytes,
        "baseline_bytes": sampler.baseline_bytes,
        "total_bytes": sampler.total_bytes,
        "height": int(depth.shape[-2]),
        "width": int(depth.shape[-1]),
        "native_npz": native_npz,
        "export_dir_listing": sorted(p.name for p in export_dir.iterdir() if p.is_file()),
    }


#: Our own npz, written by _run_inference. Deliberately not "result.npz" — see there.
VERGE_NPZ_NAME = "verge-result.npz"


def _collect_artifacts(export_dir: Path, run_id: str) -> list[Artifact]:
    kinds = {
        ".glb": "glb",
        ".npz": "npz",
        ".png": "depth_preview",
        ".ply": "gs_ply",
        ".mp4": "gs_video",
    }
    artifacts: list[Artifact] = []
    for path in sorted(export_dir.iterdir()):
        if not path.is_file():
            continue
        kind = kinds.get(path.suffix.lower())
        if kind is None:
            continue
        # Exactly one artifact may carry kind "npz": the client looks it up by kind and
        # expects OUR key names (depth/confidence/extrinsics/intrinsics). DA3's own npz
        # is kept and served, but under a distinct kind, so an alphabetically earlier
        # filename can never shadow ours in the client's `find`.
        if kind == "npz" and path.name != VERGE_NPZ_NAME:
            kind = "npz_native"
        artifacts.append(
            Artifact(
                kind=kind,  # type: ignore[arg-type]
                name=path.name,
                size_bytes=path.stat().st_size,
                sha256=_sha256(path),
                url=_publish(path, run_id),
            )
        )
    return artifacts


def _publish(path: Path, run_id: str) -> str:
    """Upload to the transient GCS prefix, or fall back to serving from disk."""
    if not OUTPUT_BUCKET:
        return f"/artifact/{run_id}/{path.name}"
    from google.cloud import storage

    blob = storage.Client().bucket(OUTPUT_BUCKET).blob(f"{OUTPUT_PREFIX}/{run_id}/{path.name}")
    blob.upload_from_filename(str(path), if_generation_match=0)
    return f"gs://{OUTPUT_BUCKET}/{OUTPUT_PREFIX}/{run_id}/{path.name}"


def _discard_frames(run_dir: Path) -> int:
    """Drop a run's uploaded frames. Returns the bytes released.

    Frames are input. Once `model.inference` has returned, nothing reads them again --
    `_collect_artifacts` and `/artifact` both work exclusively out of `exports/`. Keeping
    them was pure residue: measured on the door clip, 4.7 MB of the 126 MB a 112-frame run
    left behind, held for the life of the instance for no reader.
    """
    frame_dir = run_dir / "frames"
    if not frame_dir.is_dir():
        return 0
    released = sum(p.stat().st_size for p in frame_dir.rglob("*") if p.is_file())
    shutil.rmtree(frame_dir, ignore_errors=True)
    return released


def _sweep_expired_runs(ttl_seconds: int = RUN_TTL_SECONDS, now: float | None = None) -> list[str]:
    """Delete run directories that have outlived the retention window.

    Called at the top of every /infer, which is the only moment new disk gets claimed and
    therefore the only moment the sweep is worth its syscalls. A symlinked entry is skipped
    rather than followed -- RUN_ROOT lives under the OS temp directory, and rmtree through
    a link would delete somebody else's tree.
    """
    if not RUN_ROOT.is_dir():
        return []
    cutoff = (now if now is not None else time.time()) - ttl_seconds
    removed: list[str] = []
    for path in sorted(RUN_ROOT.iterdir()):
        if path.is_symlink() or not path.is_dir():
            continue
        try:
            if path.stat().st_mtime >= cutoff:
                continue
        except OSError:  # vanished under us, or unreadable; either way not ours to chase
            continue
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            removed.append(path.name)
    return removed


@app.post("/infer", response_model=InferManifest)
async def infer(
    frames: list[UploadFile] = File(...),
    params: str = Form("{}"),
) -> InferManifest:
    global _busy

    try:
        parsed = InferParams(**json.loads(params))
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"bad params: {exc}") from exc

    if len(frames) < 2:
        raise HTTPException(
            status_code=422,
            detail="DA3 needs multiple views — single images skip cross-view attention entirely",
        )
    if len(frames) > parsed.max_frames:
        raise HTTPException(
            status_code=422,
            detail=f"{len(frames)} frames exceeds max_frames={parsed.max_frames}; "
            "lower the sampling fps rather than truncating the clip",
        )
    if not vram.cuda_available():
        raise HTTPException(status_code=503, detail="no CUDA device")

    # Before claiming new disk, release any that has expired.
    _sweep_expired_runs()

    run_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    run_dir = RUN_ROOT / run_id
    frame_dir = run_dir / "frames"
    export_dir = run_dir / "exports"
    frame_dir.mkdir(parents=True)
    export_dir.mkdir(parents=True)

    frame_paths: list[str] = []
    for index, upload in enumerate(frames):
        target = frame_dir / f"frame-{index:04d}.jpg"
        with target.open("wb") as handle:
            shutil.copyfileobj(upload.file, handle)
        frame_paths.append(str(target))

    wall_started = time.monotonic()
    loop = asyncio.get_running_loop()
    async with _infer_lock:
        _busy = True
        try:
            result = await loop.run_in_executor(
                _executor, _run_inference, frame_paths, parsed, export_dir
            )
        except Exception as exc:  # surface the real reason, OOM included
            shutil.rmtree(run_dir, ignore_errors=True)
            raise HTTPException(status_code=500, detail=f"inference failed: {exc}") from exc
        finally:
            _busy = False

    # The GPU is done with them, so they stop costing us anything to keep.
    _discard_frames(run_dir)

    manifest = InferManifest(
        run_id=run_id,
        params=parsed,
        frames=FrameInfo(
            count=len(frame_paths),
            requested_count=len(frame_paths),
            width=result["width"],
            height=result["height"],
            capped=False,
            effective_fps=parsed.fps,
        ),
        timing=Timing(
            gpu_seconds=result["gpu_seconds"],
            wall_seconds=time.monotonic() - wall_started,
            model_load_seconds=_model_load_seconds,
        ),
        vram=VramStats(
            peak_bytes=result["peak_bytes"],
            current_bytes=int(vram.current_snapshot()["current_bytes"]),
            total_bytes=result["total_bytes"],
            device_name=vram.device_name(),
            torch_peak_bytes=result["torch_peak_bytes"],
            baseline_bytes=result["baseline_bytes"],
        ),
        artifacts=_collect_artifacts(export_dir, run_id),
        diagnostics=Diagnostics(
            native_npz=result["native_npz"],
            export_dir_listing=result["export_dir_listing"],
        ),
    )
    (run_dir / "manifest.json").write_text(manifest.model_dump_json(indent=2))
    return manifest


@app.get("/artifact/{run_id}/{name}")
def artifact(run_id: str, name: str) -> FileResponse:
    # Defend against path traversal in both segments.
    if "/" in run_id or "/" in name or ".." in run_id or ".." in name:
        raise HTTPException(status_code=400, detail="bad path")
    path = RUN_ROOT / run_id / "exports" / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such artifact")
    return FileResponse(path)


@app.post("/shutdown")
async def shutdown() -> dict[str, str]:
    """Release the model so the instance can scale down without waiting out the
    idle timeout. GPU time is billed for the instance's whole lifetime, so this
    button is a real cost lever, not a nicety."""
    global _model, _model_load_seconds
    _model = None
    _model_load_seconds = None
    if vram.cuda_available():
        import torch

        torch.cuda.empty_cache()
    return {"status": "released"}
