#!/usr/bin/env bash
# One short real run against the deployed service. The post-deploy sanity check.
#
# Deliberately small (4 frames) and deliberately single — never loop GPU runs. If you
# need several configurations, use scripts/vram-sweep.sh, which batches them against
# one warm instance instead of paying a cold start per run.
#
# Usage: VERGE_URL=... VERGE_TOKEN=... ./scripts/smoke-infer.sh [video]
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VERGE_URL:?set VERGE_URL to the deployed service URL}"
: "${VERGE_TOKEN:?set VERGE_TOKEN=\$(gcloud auth print-identity-token)}"

VIDEO="${1:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

if [[ -z "${VIDEO}" ]]; then
  echo "== no video given, synthesising a 4s test clip =="
  VIDEO="${WORK}/synthetic.mp4"
  ffmpeg -nostdin -v error -f lavfi -i "testsrc=duration=4:size=640x360:rate=30" \
    -c:v libx264 -pix_fmt yuv420p -y "${VIDEO}"
fi

echo "== health =="
curl -sS -f -H "Authorization: Bearer ${VERGE_TOKEN}" "${VERGE_URL}/health"
echo

echo "== extracting 4 frames locally =="
node scripts/extract-frames.mjs "${VIDEO}" "${WORK}/frames" --fps 60 --max-frames 4

ARGS=()
for f in "${WORK}"/frames/*.jpg; do ARGS+=(-F "frames=@${f}"); done
ARGS+=(-F 'params={"fps":60,"process_res":504,"ref_view_strategy":"middle","max_frames":4}')

echo "== infer (cold start ~3 min on first call) =="
START=$(date +%s)
curl -sS -f -H "Authorization: Bearer ${VERGE_TOKEN}" \
  -X POST "${VERGE_URL}/infer" "${ARGS[@]}" > "${WORK}/manifest.json"
echo "wall: $(( $(date +%s) - START ))s"

python3 - "${WORK}/manifest.json" <<'PY'
import json, sys

manifest = json.load(open(sys.argv[1]))
assert manifest["schema_version"] == "verge.infer-manifest/0.1.0", "schema drift"
assert manifest["depth_mode"] == "metric"
kinds = {a["kind"] for a in manifest["artifacts"]}
assert "glb" in kinds, f"no GLB in artifacts: {kinds}"
assert "npz" in kinds, f"no NPZ in artifacts: {kinds}"

vram = manifest["vram"]
print(
    f"OK  {manifest['frames']['count']} frames · "
    f"{manifest['timing']['gpu_seconds']:.2f}s GPU · "
    f"peak {vram['peak_bytes'] / 1024 ** 3:.2f} GiB / "
    f"{vram['total_bytes'] / 1024 ** 3:.2f} GiB · "
    f"artifacts {sorted(kinds)}"
)

# Durable storage is the difference between a result that survives teardown and one that
# does not, and it fails SILENTLY by design -- _publish degrades rather than raising, so a
# run with no bucket access looks completely healthy right up to the moment the service is
# deleted. This is the cheapest place to notice.
diagnostics = manifest.get("diagnostics") or {}
mode = diagnostics.get("publish_mode", "local")
print(f"    publish_mode: {mode}")
for error in diagnostics.get("publish_errors", []):
    print(f"    !! {error}")

if mode != "gcs":
    raise SystemExit(
        f"\nFAILED: artifacts did not reach durable storage (publish_mode={mode}).\n"
        "The run itself is fine and is on the instance, but it dies with it, and this\n"
        "revision deploys with --min-instances=0. Fix before running anything expensive."
    )

for artifact in manifest["artifacts"]:
    assert artifact.get("gs_uri", "").startswith("gs://"), f"no gs_uri on {artifact['name']}"
    # The prefix the bucket lifecycle rule matches. A mismatch here means the objects
    # never expire -- the exact way the donor bucket accumulated forever.
    assert "/runs/transient/" in artifact["gs_uri"], artifact["gs_uri"]
    assert artifact["url"].startswith("https://storage.googleapis.com/"), artifact["url"]
    assert "X-Goog-Signature=" in artifact["url"], f"{artifact['name']} url is not signed"
print(f"    all {len(manifest['artifacts'])} artifacts signed and under runs/transient/")
PY

echo
echo "Instance is warm and billing. Run scripts/teardown.sh when finished."
