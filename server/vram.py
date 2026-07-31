"""VRAM telemetry.

`torch.cuda.max_memory_allocated()` only counts the PyTorch caching allocator — it
misses the CUDA context, cuDNN/cuBLAS workspaces, and fragmentation, which is a large
slice of real usage. The driver's own `mem_get_info()` reports what actually matters
for "will this fit on a 24 GiB L4", so we sample that on a background thread while
inference runs and keep the high-water mark.
"""

from __future__ import annotations

import threading
import time

try:  # torch is absent in local/mock runs
    import torch
except ImportError:  # pragma: no cover - exercised only outside the GPU image
    torch = None  # type: ignore[assignment]


def cuda_available() -> bool:
    return torch is not None and torch.cuda.is_available()


def device_name() -> str:
    return torch.cuda.get_device_name(0) if cuda_available() else "cpu"


def driver_memory() -> tuple[int, int]:
    """(used_bytes, total_bytes) as the driver sees them."""
    if not cuda_available():
        return 0, 0
    free, total = torch.cuda.mem_get_info()
    return total - free, total


class VramSampler:
    """Polls driver VRAM on a thread and records the peak.

    Used as a context manager around the inference call. The poll interval is
    coarse enough to be free (100 ms) and fine enough to catch the peak, which on
    DA3 sits on a plateau lasting seconds, not a spike lasting microseconds.
    """

    def __init__(self, interval_s: float = 0.1) -> None:
        self.interval_s = interval_s
        self.peak_bytes = 0
        self.total_bytes = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _poll(self) -> None:
        while not self._stop.is_set():
            used, total = driver_memory()
            self.peak_bytes = max(self.peak_bytes, used)
            self.total_bytes = total or self.total_bytes
            self._stop.wait(self.interval_s)

    def __enter__(self) -> "VramSampler":
        if cuda_available():
            torch.cuda.reset_peak_memory_stats()
        used, total = driver_memory()
        self.peak_bytes = used
        self.total_bytes = total
        self._thread = threading.Thread(target=self._poll, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        if cuda_available():
            torch.cuda.synchronize()
        # One final read so a peak reached just before exit isn't missed.
        used, total = driver_memory()
        self.peak_bytes = max(self.peak_bytes, used)
        self.total_bytes = total or self.total_bytes
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)


def current_snapshot() -> dict[str, int | str]:
    used, total = driver_memory()
    torch_peak = int(torch.cuda.max_memory_allocated()) if cuda_available() else 0
    return {
        "current_bytes": used,
        "peak_bytes": max(used, torch_peak),
        "total_bytes": total,
        "device_name": device_name(),
    }


def timed() -> float:
    return time.monotonic()
