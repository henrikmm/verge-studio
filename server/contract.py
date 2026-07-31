"""Wire contract for the DA3 inference service.

This module is the single source of truth for the /infer request and response
shapes. `app/src/lib/contract.ts` mirrors it field for field — change both together.

Defaults here are the verified upstream values; see docs/SOURCES.md.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = "verge.infer-manifest/0.1.0"

MODEL_REPOSITORY_ID = "depth-anything/DA3NESTED-GIANT-LARGE-1.1"
MODEL_REVISION = "b2359bdf726fb44ef62acca04d629dcf158053e7"

# The L4 we deploy on. Used for the UI's VRAM budget bar.
L4_TOTAL_VRAM_BYTES = 24 * 1024**3

# Frame-count ceiling. This is a safety rail, not a quality target: DA3 itself
# imposes no cap, and its in-repo memory estimator under-predicts real usage ~4x,
# so the real ceiling has to come from a measured sweep. Until that sweep runs,
# this stays conservative.
DEFAULT_MAX_FRAMES = 16

ProcessResMethod = Literal["upper_bound_resize", "lower_bound_resize"]
RefViewStrategy = Literal["first", "middle", "saddle_balanced", "saddle_sim_range"]
ExportFormat = Literal["npz", "mini_npz", "glb", "gs_ply", "gs_video"]


class InferParams(BaseModel):
    """Inference knobs. Every one of these is surfaced in the app's inspector so
    settings can be compared across runs."""

    # Informational: the sampling rate the client's ffmpeg pass actually used.
    # The server does not resample; frames arrive already extracted (local-first).
    fps: float = Field(default=10.0, gt=0, le=60)
    source_duration_s: float | None = Field(default=None, gt=0)

    process_res: int = Field(default=504, ge=126, le=1024)
    process_res_method: ProcessResMethod = "upper_bound_resize"
    ref_view_strategy: RefViewStrategy = "middle"
    infer_gs: bool = False

    max_frames: int = Field(default=DEFAULT_MAX_FRAMES, ge=2, le=200)


class Artifact(BaseModel):
    kind: Literal["glb", "npz", "depth_preview", "gs_ply", "gs_video"]
    name: str
    size_bytes: int
    sha256: str
    # Either a signed GCS URL or a path on this service (/artifact/{run_id}/{name}).
    url: str


class VramStats(BaseModel):
    """Peak is what matters for capacity planning; current is what the live
    telemetry poll reports mid-run."""

    peak_bytes: int
    current_bytes: int
    total_bytes: int
    device_name: str

    @property
    def peak_fraction(self) -> float:
        return self.peak_bytes / self.total_bytes if self.total_bytes else 0.0


class Timing(BaseModel):
    gpu_seconds: float
    wall_seconds: float
    model_load_seconds: float | None = None


class FrameInfo(BaseModel):
    count: int
    requested_count: int
    width: int
    height: int
    # True when fps x duration exceeded max_frames and we sampled down.
    capped: bool = False
    effective_fps: float | None = None


class InferManifest(BaseModel):
    schema_version: str = SCHEMA_VERSION
    run_id: str
    model_repository_id: str = MODEL_REPOSITORY_ID
    model_revision: str = MODEL_REVISION
    depth_mode: Literal["metric"] = "metric"
    linear_unit: Literal["metre"] = "metre"

    params: InferParams
    frames: FrameInfo
    timing: Timing
    vram: VramStats
    artifacts: list[Artifact]

    # Transient by policy — the client must call Save explicitly to retain.
    transient: bool = True
    expires_after_days: int = 3


class GpuSnapshot(BaseModel):
    """Polled by the UI during inference for the live VRAM readout."""

    available: bool
    model_loaded: bool
    busy: bool
    device_name: str = ""
    current_bytes: int = 0
    peak_bytes: int = 0
    total_bytes: int = L4_TOTAL_VRAM_BYTES


class HealthResponse(BaseModel):
    status: Literal["ok"]
    model_loaded: bool
    gpu_available: bool
    model_revision: str = MODEL_REVISION


class WarmupResponse(BaseModel):
    model_loaded: bool
    model_load_seconds: float
    gpu: GpuSnapshot
