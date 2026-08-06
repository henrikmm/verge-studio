"""Contract smoke for server/main.py without a GPU or DA3 installed."""
import io
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)

# /health on a CPU box
r = client.get("/health")
assert r.status_code == 200, r.text
body = r.json()
assert body["status"] == "ok"
assert body["gpu_available"] is False
assert body["model_loaded"] is False
print("healthz OK:", body)

# /gpu must answer even with no CUDA
r = client.get("/gpu")
assert r.status_code == 200, r.text
gpu = r.json()
assert gpu["available"] is False and gpu["busy"] is False
assert gpu["total_bytes"] > 0, "total_bytes must fall back to the L4 budget"
print("gpu OK:", gpu)

# /warmup must refuse without CUDA rather than crash
r = client.post("/warmup")
assert r.status_code == 503, r.text
print("warmup refuses without CUDA OK")

def frame(name):
    return ("frames", (name, io.BytesIO(b"\xff\xd8\xff\xe0fake"), "image/jpeg"))

# single frame -> 422 with the multi-view explanation
r = client.post("/infer", files=[frame("a.jpg")], data={"params": "{}"})
assert r.status_code == 422, r.text
assert "multiple views" in r.json()["detail"], r.json()
print("single-frame rejection OK:", r.json()["detail"][:60])

# over the cap -> 422 telling the user to lower fps, not truncate
r = client.post(
    "/infer",
    files=[frame(f"{i}.jpg") for i in range(5)],
    data={"params": json.dumps({"max_frames": 4})},
)
assert r.status_code == 422, r.text
assert "lower the sampling fps" in r.json()["detail"], r.json()
print("cap rejection OK:", r.json()["detail"][:70])

# malformed params -> 422
r = client.post("/infer", files=[frame("a.jpg"), frame("b.jpg")], data={"params": "{nope"})
assert r.status_code == 422 and "bad params" in r.json()["detail"], r.text
print("bad params OK")

# valid request on a CPU box -> 503 no CUDA (must not 500)
r = client.post("/infer", files=[frame("a.jpg"), frame("b.jpg")], data={"params": "{}"})
assert r.status_code == 503, r.text
print("no-CUDA infer OK:", r.json()["detail"])

# artifact path traversal is refused
r = client.get("/artifact/..%2f..%2fetc/passwd")
assert r.status_code in (400, 404), r.text
r = client.get("/artifact/run/..")
assert r.status_code in (400, 404), r.text
print("path traversal refused OK")

# defaults track the verified upstream values
p = main.InferParams()
assert (p.process_res, p.ref_view_strategy, p.fps, p.infer_gs) == (504, "middle", 10.0, False)
# Cap set from the 2026-08-01 ladder: 144 ran, 160 OOMed, 112 leaves ~15% headroom.
assert p.max_frames == 112
print("defaults OK:", p.model_dump())

# The frame ladder runs to 256, so the wire bound must not reject it before the GPU
# gets a chance to OOM -- that failure is the measurement, and a 422 is not.
assert main.InferParams(max_frames=256).max_frames == 256
try:
    main.InferParams(max_frames=513)
except ValueError:
    pass
else:
    raise AssertionError("max_frames must still have an upper bound")
print("ladder frame counts accepted OK")

# VramStats carries both peaks. The driver number alone was cumulative on a warm
# instance; the allocator number is what isolates a single run.
from contract import Diagnostics, VramStats  # noqa: E402

v = VramStats(peak_bytes=15_065_939_968, current_bytes=0, total_bytes=23_659_151_360,
              device_name="NVIDIA L4", torch_peak_bytes=8_000_000_000,
              baseline_bytes=7_050_625_024)
assert v.activation_bytes == 15_065_939_968 - 7_050_625_024
# Manifests written before 2026-08-01 have neither field; they must still parse.
old = VramStats(peak_bytes=1, current_bytes=1, total_bytes=1, device_name="x")
assert old.torch_peak_bytes == 0 and old.baseline_bytes == 0
print("vram stats OK: activation", v.activation_bytes)

# Our npz must never be shadowed by DA3's in a lookup by kind. The client finds the
# depth arrays with artifacts.find(kind == "npz") and expects OUR key names.
import tempfile  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    d = Path(tmp)
    # "result.npz" sorts BEFORE "verge-result.npz", so a plain suffix map would have
    # handed the client DA3's file. This is the regression this check exists for.
    for name in ("result.npz", main.VERGE_NPZ_NAME, "scene.glb", "notes.txt"):
        (d / name).write_bytes(b"x")
    arts = main._collect_artifacts(d, "run", [])
    by_kind = {a.kind: a.name for a in arts}
    assert by_kind["npz"] == main.VERGE_NPZ_NAME, by_kind
    assert by_kind["npz_native"] == "result.npz", by_kind
    assert by_kind["glb"] == "scene.glb", by_kind
    assert "notes.txt" not in {a.name for a in arts}, "unknown suffixes must be skipped"
print("npz kind disambiguation OK:", by_kind)

# ----------------------------------------------------------------- durable publishing
#
# Results have to outlive the instance that produced them. Everything below runs against
# fakes: the point is the BRANCHING, which is what decides whether a paid run survives.

with tempfile.TemporaryDirectory() as tmp:
    d = Path(tmp)
    (d / "scene.glb").write_bytes(b"g" * 16)

    # No bucket configured -> the local path, exactly as before, and no gs_uri to mislead
    # save-run.sh into trying `gcloud storage cp` on nothing.
    original_bucket = main.OUTPUT_BUCKET
    try:
        main.OUTPUT_BUCKET = ""
        notes: list[str] = []
        url, gs_uri = main._publish(d / "scene.glb", "run-1", notes)
        assert url == "/artifact/run-1/scene.glb", url
        assert gs_uri is None and notes == []
        assert main._publish_mode(notes) == "local"
        print("publish without a bucket OK:", url)

        # Bucket configured and everything works -> a signed link for the browser AND the
        # durable address for Save. Both, because they expire differently.
        uploaded = {}

        class FakeBlob:
            def upload_from_filename(self, path, if_generation_match=None):
                uploaded["path"] = path
                uploaded["guard"] = if_generation_match

            def generate_signed_url(self, **kw):
                uploaded["sign_kwargs"] = kw
                return "https://storage.googleapis.com/signed?x=1"

        class FakeBucket:
            def blob(self, name):
                uploaded["object"] = name
                return FakeBlob()

        class FakeClient:
            def bucket(self, name):
                uploaded["bucket"] = name
                return FakeBucket()

        main.OUTPUT_BUCKET = "verge-lab-runs"
        main._storage_client = FakeClient()
        main._signing_credentials = type(
            "C", (), {"valid": True, "token": "t", "service_account_email": "sa@x.iam"}
        )()

        notes = []
        url, gs_uri = main._publish(d / "scene.glb", "run-1", notes)
        assert url.startswith("https://"), url
        assert gs_uri == "gs://verge-lab-runs/runs/transient/run-1/scene.glb", gs_uri
        assert notes == [] and main._publish_mode(notes) == "gcs"
        # The prefix the lifecycle rule matches. If this ever changes, scripts/bucket-lifecycle.json
        # stops covering the objects and they never expire -- the exact donor-bucket failure.
        assert uploaded["object"].startswith("runs/transient/"), uploaded["object"]
        # Never overwrite: a run id collision means something is badly wrong.
        assert uploaded["guard"] == 0
        assert uploaded["sign_kwargs"]["version"] == "v4"
        assert uploaded["sign_kwargs"]["method"] == "GET"
        # Signing must go through IAM signBlob; there is no private key inside Cloud Run.
        assert uploaded["sign_kwargs"]["service_account_email"] == "sa@x.iam"
        assert uploaded["sign_kwargs"]["access_token"] == "t"
        print("publish to GCS OK:", gs_uri)

        # THE ONE THAT MATTERS. Publishing runs after the GPU has been paid for, so a
        # storage failure must degrade rather than raise -- a 500 here throws away a
        # finished run to report a problem that costs nothing to route around.
        class ExplodingClient:
            def bucket(self, name):
                raise RuntimeError("403 caller lacks storage.objects.create")

        main._storage_client = ExplodingClient()
        notes = []
        url, gs_uri = main._publish(d / "scene.glb", "run-1", notes)
        assert url == "/artifact/run-1/scene.glb", url
        assert gs_uri is None, gs_uri
        assert len(notes) == 1 and "RuntimeError" in notes[0], notes
        # ...and it must be VISIBLE. A silent fallback would quietly restore the
        # instance-lifetime dependency this whole path exists to remove.
        assert main._publish_mode(notes) == "degraded"
        print("publish failure degrades without failing the run OK:", notes[0][:52])
    finally:
        main.OUTPUT_BUCKET = original_bucket
        main._storage_client = None
        main._signing_credentials = None

# /publish-check refuses honestly when there is nothing to check, rather than 500ing
# somewhere inside the storage client.
r = client.get("/publish-check")
assert r.status_code == 503, r.text
assert "VERGE_OUTPUT_BUCKET" in r.json()["detail"], r.json()
print("publish-check without a bucket OK:", r.json()["detail"][:60])

# An Artifact written before gs_uri existed must still parse -- saved manifests on disk
# predate this field and loading one is how a run is re-opened.
from contract import Artifact  # noqa: E402

legacy = Artifact(kind="glb", name="scene.glb", size_bytes=1, sha256="x", url="/artifact/r/scene.glb")
assert legacy.gs_uri is None
print("legacy artifact without gs_uri parses OK")

# Transience is enforced, not inherited from the instance dying. Two mechanisms:
# frames go as soon as inference returns, whole runs go once they pass the TTL.
import os  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    run_dir = Path(tmp) / "run-1"
    (run_dir / "frames").mkdir(parents=True)
    (run_dir / "exports").mkdir()
    (run_dir / "frames" / "frame-0000.jpg").write_bytes(b"x" * 1024)
    (run_dir / "frames" / "frame-0001.jpg").write_bytes(b"x" * 2048)
    (run_dir / "exports" / "scene.glb").write_bytes(b"g")

    released = main._discard_frames(run_dir)
    assert released == 3072, released
    assert not (run_dir / "frames").exists(), "frames must not survive inference"
    assert (run_dir / "exports" / "scene.glb").is_file(), "exports must survive; the client fetches them"
    # Idempotent: a re-entered run must not explode on the second call.
    assert main._discard_frames(run_dir) == 0
print("frame discard OK: released 3072 bytes, exports intact")

with tempfile.TemporaryDirectory() as tmp:
    original_root = main.RUN_ROOT
    main.RUN_ROOT = Path(tmp) / "verge-runs"
    try:
        fresh = main.RUN_ROOT / "20260806-120000-aaaaaa"
        stale = main.RUN_ROOT / "20260801-010000-bbbbbb"
        for d in (fresh, stale):
            (d / "exports").mkdir(parents=True)
            (d / "exports" / "verge-result.npz").write_bytes(b"n")
        old = time.time() - (48 * 60 * 60)
        os.utime(stale, (old, old))

        removed = main._sweep_expired_runs(ttl_seconds=6 * 60 * 60)
        assert removed == [stale.name], removed
        assert not stale.exists() and fresh.exists(), "the sweep must take only what expired"

        # A run inside the window is never touched, however many times /infer fires.
        assert main._sweep_expired_runs(ttl_seconds=6 * 60 * 60) == []
        assert fresh.exists()

        # A symlink is skipped, not followed: RUN_ROOT sits in the OS temp directory and
        # rmtree through a link would delete a tree that is not ours.
        outsider = Path(tmp) / "outsider"
        (outsider / "keep").mkdir(parents=True)
        link = main.RUN_ROOT / "linked"
        link.symlink_to(outsider, target_is_directory=True)
        os.utime(link, (old, old), follow_symlinks=False)
        main._sweep_expired_runs(ttl_seconds=6 * 60 * 60)
        assert (outsider / "keep").is_dir(), "the sweep followed a symlink"
    finally:
        main.RUN_ROOT = original_root
print("run sweep OK: expired taken, live kept, symlink skipped")

# A missing root is the normal cold-start state, not an error.
with tempfile.TemporaryDirectory() as tmp:
    original_root = main.RUN_ROOT
    main.RUN_ROOT = Path(tmp) / "never-created"
    try:
        assert main._sweep_expired_runs() == []
    finally:
        main.RUN_ROOT = original_root
print("sweep on missing root OK")

diag = Diagnostics(native_npz={"result.npz": ["depth", "conf"]}, export_dir_listing=["a"])
assert diag.native_npz["result.npz"] == ["depth", "conf"]
assert Diagnostics().native_npz == {} and Diagnostics().export_dir_listing == []
# Defaults describe the pre-bucket world, so a manifest written before publishing existed
# still parses and reads as what it was: artifacts on one machine's disk.
assert Diagnostics().publish_mode == "local" and Diagnostics().publish_errors == []
assert Diagnostics(publish_mode="degraded", publish_errors=["x"]).publish_mode == "degraded"
print("diagnostics OK")

print("\nALL SERVER CONTRACT CHECKS PASSED")
