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

# MEASURED from torch.cuda.mem_get_info() on the deployed L4 (2026-07-31): 22.03 GiB
# usable. The advertised "24 GB" is decimal and some is reserved.
L4_TOTAL_VRAM_BYTES = 23_659_151_360

# Frame-count ceiling — a safety rail, not a quality target (DA3 imposes none).
# Set from the 2026-08-01 ladder in docs/vram-measurements.json. MEASURED: 144 frames
# @ 504 px ran at 21.88 GiB of 22.03; 160 OOMed. 112 sits deliberately below that
# ceiling with ~15% headroom (17.23 GiB allocator), because 128 and 144 both completed
# at ~99% of the device, which is a coin flip rather than an operating point.
# Mirrors DEFAULT_MAX_FRAMES in app/src/lib/contract.ts.
DEFAULT_MAX_FRAMES = 112

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

    # Upper bound raised 200 -> 512 on 2026-08-01: the frame ladder runs to 256, and at
    # 200 pydantic rejected the request before it could reach the GPU and OOM, which is
    # the datapoint the ladder exists to collect. This bound is a wire sanity check, not
    # the safety rail — that is max_frames itself, defaulting to DEFAULT_MAX_FRAMES.
    max_frames: int = Field(default=DEFAULT_MAX_FRAMES, ge=2, le=512)


class Artifact(BaseModel):
    # "npz" is OUR array bundle, with the key names app/src/lib/npz.ts reads.
    # "npz_native" is whatever DA3's own exporter wrote — kept, served, but never
    # mistaken for ours by a client looking artifacts up by kind.
    kind: Literal["glb", "npz", "npz_native", "depth_preview", "gs_ply", "gs_video"]
    name: str
    size_bytes: int
    sha256: str
    # Either a signed GCS URL or a path on this service (/artifact/{run_id}/{name}).
    url: str


class VramStats(BaseModel):
    """Peak is what matters for capacity planning; current is what the live
    telemetry poll reports mid-run.

    `peak_bytes` (driver) and `torch_peak_bytes` (caching allocator) answer different
    questions and routinely disagree — see the module docstring in server/vram.py.
    Use the driver peak to decide whether a configuration fits; use the allocator peak
    and `baseline_bytes` to model what an extra frame costs.

    The two new fields default to 0 so manifests written before 2026-08-01 still parse.
    """

    peak_bytes: int
    current_bytes: int
    total_bytes: int
    device_name: str
    # Allocator high-water mark, isolated to this run by empty_cache() at entry.
    torch_peak_bytes: int = 0
    # Driver usage at run start, after the cache was dropped: model + CUDA context.
    baseline_bytes: int = 0

    @property
    def peak_fraction(self) -> float:
        return self.peak_bytes / self.total_bytes if self.total_bytes else 0.0

    @property
    def activation_bytes(self) -> int:
        """Marginal cost of this run's frames, above the resident model."""
        return max(0, self.peak_bytes - self.baseline_bytes)


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


class Diagnostics(BaseModel):
    """Facts observed during a run that answer open questions without spending
    another cloud session on them. Purely additive — nothing downstream requires it.

    `native_npz` maps each npz DA3 wrote to its key names, which is how we confirm
    what DA3 calls its own arrays rather than guessing from the fixture.
    """

    native_npz: dict[str, list[str]] = Field(default_factory=dict)
    export_dir_listing: list[str] = Field(default_factory=list)


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
    diagnostics: Diagnostics | None = None

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
