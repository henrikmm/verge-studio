"""Contract smoke for server/main.py without a GPU or DA3 installed."""
import io
import json
import sys
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
assert p.max_frames == 32
print("defaults OK:", p.model_dump())

print("\nALL SERVER CONTRACT CHECKS PASSED")
