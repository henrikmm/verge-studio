"""VRAM telemetry.

Two numbers, because neither one alone answers both questions we ask of it.

`torch.cuda.max_memory_allocated()` counts only the PyTorch caching allocator — it
misses the CUDA context, cuDNN/cuBLAS workspaces, and fragmentation, which is a large
slice of real usage. The driver's own `mem_get_info()` reports what actually matters
for "will this fit on a 22 GiB L4", so we sample that on a background thread while
inference runs and keep the high-water mark.

But the driver number has a failure mode of its own: the caching allocator holds freed
blocks between runs, so on a warm instance the driver reading includes cache from
*earlier* runs and reports a cumulative high-water mark rather than this run's cost.
The 2026-07-31 sweep shows the symptom plainly — 8 and 16 frames both reported exactly
12.79 GiB, 24 and 32 both 14.03 GiB, quantised to allocator growth steps instead of
tracking frame count.

So each run now starts from a known floor: `empty_cache()` returns cached blocks to the
driver and `reset_peak_memory_stats()` zeroes the allocator's high-water mark. We record
the driver peak (a safe upper bound, what a capacity plan needs), the allocator peak
(isolated to this run, what a cost model needs), and the baseline the run started from,
so `peak - baseline` is the marginal cost of the frames themselves.

`empty_cache()` costs a little time — the next allocation goes back to the driver rather
than hitting cache — which is the price of a measurement that means something.
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
    """Polls driver VRAM on a thread and records this run's peak.

    Used as a context manager around the inference call. The poll interval is
    coarse enough to be free (100 ms) and fine enough to catch the peak, which on
    DA3 sits on a plateau lasting seconds, not a spike lasting microseconds.

    Attributes after exit:
      peak_bytes       driver high-water mark — capacity planning, safe upper bound
      torch_peak_bytes allocator high-water mark, isolated to this run — cost model
      baseline_bytes   driver usage at entry, after the cache was dropped
      total_bytes      device total
    """

    def __init__(self, interval_s: float = 0.1) -> None:
        self.interval_s = interval_s
        self.peak_bytes = 0
        self.torch_peak_bytes = 0
        self.baseline_bytes = 0
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
            # Order matters. Synchronise so nothing from a previous run is still in
            # flight, drop cached blocks so the driver baseline reflects what is truly
            # resident, then zero the allocator's high-water mark. Without the
            # empty_cache() the baseline is inflated by the last run's cache and every
            # reading is cumulative.
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
        used, total = driver_memory()
        self.baseline_bytes = used
        self.peak_bytes = used
        self.total_bytes = total
        self._thread = threading.Thread(target=self._poll, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        if cuda_available():
            torch.cuda.synchronize()
            self.torch_peak_bytes = int(torch.cuda.max_memory_allocated())
        # One final read so a peak reached just before exit isn't missed.
        used, total = driver_memory()
        self.peak_bytes = max(self.peak_bytes, used)
        self.total_bytes = total or self.total_bytes
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)

    @property
    def activation_bytes(self) -> int:
        """Marginal driver cost of this run above its resting baseline.

        This is the quantity the frame ladder is actually fitting a slope to — the
        raw peak includes the ~6.6 GiB resident model, which does not grow with
        frame count.
        """
        return max(0, self.peak_bytes - self.baseline_bytes)


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
