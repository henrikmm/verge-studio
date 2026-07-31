from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from typing import Any

import numpy as np
from PIL import Image
import torch
from depth_anything_3.api import DepthAnything3


PLAN_PATH = Path("/app/plan.json")
WORK_DIR = Path("/tmp/mvl029-demo")


def run_checked(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=True, text=True, capture_output=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def emit(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, sort_keys=True), flush=True)


def resolve_media_url(source_url: str) -> str:
    result = run_checked(
        [
            "yt-dlp",
            "--no-playlist",
            "--quiet",
            "--no-warnings",
            "--format",
            "best[ext=mp4]/best",
            "--get-url",
            source_url,
        ]
    )
    urls = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not urls:
        raise RuntimeError("yt-dlp resolved no media URL")
    return urls[0]


def probe_duration_seconds(media_url: str) -> float:
    result = run_checked(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            media_url,
        ]
    )
    return float(result.stdout.strip())


def extract_remote_frames(
    media_url: str,
    start_seconds: float,
    clip_seconds: float,
    frame_count: int,
) -> list[Path]:
    frame_dir = WORK_DIR / "frames"
    frame_dir.mkdir(parents=True, exist_ok=False)
    fps = frame_count / clip_seconds
    run_checked(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-ss",
            f"{start_seconds:.6f}",
            "-i",
            media_url,
            "-t",
            f"{clip_seconds:.6f}",
            "-vf",
            f"fps={fps:.9f}",
            "-frames:v",
            str(frame_count),
            "-q:v",
            "2",
            str(frame_dir / "frame-%03d.jpg"),
        ]
    )
    frames = sorted(frame_dir.glob("frame-*.jpg"))
    if len(frames) < 3:
        raise RuntimeError(f"remote video produced only {len(frames)} useful frames")
    return frames


def download_gcs_media(gcs_uri: str, destination: Path) -> None:
    if not gcs_uri.startswith("gs://") or "/" not in gcs_uri[5:]:
        raise RuntimeError("MVL_INPUT_GCS_URI must name one gs://bucket/object")
    bucket_name, object_name = gcs_uri[5:].split("/", 1)
    from google.cloud import storage

    storage.Client().bucket(bucket_name).blob(object_name).download_to_filename(destination)


def make_depth_preview(depth: np.ndarray, destination: Path) -> None:
    finite = np.isfinite(depth)
    if not finite.any():
        raise RuntimeError("DA3 produced no finite depth values")
    low, high = np.percentile(depth[finite], [2, 98])
    normalized = np.clip((depth - low) / max(float(high - low), 1e-8), 0, 1)
    Image.fromarray((normalized * 255).astype(np.uint8), mode="L").save(destination)


def write_canonical_ply(
    prediction: Any,
    destination: Path,
    max_points: int = 250_000,
) -> dict[str, Any]:
    depth = np.asarray(prediction.depth)
    confidence = np.asarray(prediction.conf)
    extrinsics = np.asarray(prediction.extrinsics)
    intrinsics = np.asarray(prediction.intrinsics)
    if extrinsics.shape[-2:] != (3, 4) or intrinsics.shape[-2:] != (3, 3):
        raise RuntimeError("DA3 camera arrays do not match the documented w2c/ixt contract")

    candidates: list[tuple[int, int, int, np.ndarray, tuple[int, int, int]]] = []
    for frame_index, frame_depth in enumerate(depth):
        height, width = frame_depth.shape
        frame_confidence = confidence[frame_index]
        finite = np.isfinite(frame_depth) & np.isfinite(frame_confidence) & (frame_depth > 0)
        threshold = float(np.percentile(frame_confidence[finite], 40)) if finite.any() else 1.0
        ys, xs = np.where(finite & (frame_confidence >= threshold))
        rotation = extrinsics[frame_index, :, :3]
        translation = extrinsics[frame_index, :, 3]
        rotation_t = rotation.T
        focal_x = float(intrinsics[frame_index, 0, 0])
        focal_y = float(intrinsics[frame_index, 1, 1])
        center_x = float(intrinsics[frame_index, 0, 2])
        center_y = float(intrinsics[frame_index, 1, 2])
        if focal_x <= 0 or focal_y <= 0:
            continue
        for y, x in zip(ys.tolist(), xs.tolist()):
            z = float(frame_depth[y, x])
            camera_point = np.array(
                [(x - center_x) * z / focal_x, (y - center_y) * z / focal_y, z],
                dtype=np.float64,
            )
            world_point = rotation_t @ (camera_point - translation)
            candidates.append((frame_index, y, x, world_point, (0, 0, 0)))

    if not candidates:
        raise RuntimeError("canonical point-cloud projection produced no points")
    stride = max(1, (len(candidates) + max_points - 1) // max_points)
    selected = candidates[::stride]
    with destination.open("w", encoding="ascii") as handle:
        handle.write("ply\nformat ascii 1.0\n")
        handle.write(f"element vertex {len(selected)}\n")
        handle.write("property float x\nproperty float y\nproperty float z\n")
        handle.write("property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n")
        for _, _, _, point, color in selected:
            handle.write(
                f"{point[0]:.7g} {point[1]:.7g} {point[2]:.7g} "
                f"{color[0]} {color[1]} {color[2]}\n"
            )
    return {
        "point_count_before_cap": len(candidates),
        "point_count": len(selected),
        "max_points": max_points,
        "construction": "confidence_percentile_filtered_depth_backprojection_with_w2c_inverse",
        "coordinate_frame": "da3_world_camera_pose",
        "linear_unit": "metre_if_model_is_metric_else_relative_scale",
    }


def main() -> None:
    started = time.monotonic()
    plan = json.loads(PLAN_PATH.read_text())
    bucket_name = os.environ["MVL_OUTPUT_BUCKET"]
    output_prefix = os.environ["MVL_OUTPUT_PREFIX"].rstrip("/") + "/"
    image_digest = os.environ["MVL_IMAGE_DIGEST"]
    model_key = os.environ.get("MVL_MODEL_KEY", "da3_nested_giant_large_1_1")
    source_key = os.environ.get("MVL_SOURCE_KEY", "primary")
    selected_model_key = plan["image"]["selected_model_key"]
    if model_key != selected_model_key:
        raise RuntimeError(
            f"final image only permits selected model {selected_model_key}, got {model_key}"
        )
    if model_key not in plan["models"]:
        raise RuntimeError(f"unknown model key: {model_key}")
    if source_key not in plan["sources"]:
        raise RuntimeError(f"unknown source key: {source_key}")
    model_spec = plan["models"][model_key]
    source_spec = plan["sources"][source_key]
    if source_spec["clip_seconds"] > plan["limits"]["max_clip_seconds"]:
        raise RuntimeError("source clip exceeds the reviewed maximum")
    if not torch.cuda.is_available():
        raise RuntimeError("one real CUDA GPU is required")
    WORK_DIR.mkdir(parents=True, exist_ok=False)

    emit("heartbeat", stage="source_resolve", elapsed_seconds=0)
    # YouTube can refuse resolver traffic from cloud data-centre addresses. A
    # short-lived direct URL may be resolved by the trusted launcher and injected
    # without downloading or persisting the source video locally.
    input_gcs_uri = os.environ.get("MVL_INPUT_GCS_URI")
    if input_gcs_uri:
        media_path = WORK_DIR / "source-window.mp4"
        download_gcs_media(input_gcs_uri, media_path)
        media_url = str(media_path)
        extraction_start_seconds = 0.0
    else:
        media_url = os.environ.get("MVL_DIRECT_MEDIA_URL") or resolve_media_url(source_spec["url"])
        extraction_start_seconds = float(source_spec["window_start_seconds"])
    source_duration = probe_duration_seconds(media_url)
    frames = extract_remote_frames(
        media_url,
        extraction_start_seconds,
        float(source_spec["clip_seconds"]),
        int(plan["limits"]["frame_count"]),
    )
    frame_hashes = [sha256_file(frame) for frame in frames]
    clip_identity = hashlib.sha256(
        json.dumps(
            {
                "source_url": source_spec["url"],
                "window_start_seconds": source_spec["window_start_seconds"],
                "clip_seconds": source_spec["clip_seconds"],
                "frame_sha256": frame_hashes,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    emit("heartbeat", stage="frames_ready", frame_count=len(frames), elapsed_seconds=round(time.monotonic() - started, 3))

    emit("heartbeat", stage="inference", model_key=model_key, elapsed_seconds=round(time.monotonic() - started, 3))
    checkpoint = Path(model_spec["local_dir"]) / model_spec["checkpoint_filename"]
    if sha256_file(checkpoint) != model_spec["checkpoint_sha256"]:
        raise RuntimeError("baked checkpoint checksum does not match the reviewed model")
    if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
        raise RuntimeError("runtime model-registry access is not disabled")
    if any(
        os.environ.get(name)
        for name in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HF_HUB_TOKEN")
    ):
        raise RuntimeError("runtime model-registry credentials are prohibited")
    model = DepthAnything3.from_pretrained(model_spec["local_dir"]).to("cuda")
    torch.cuda.reset_peak_memory_stats()
    inference_started = time.monotonic()
    export_dir = WORK_DIR / "exports"
    export_dir.mkdir()
    prediction = model.inference(
        [str(frame) for frame in frames],
        process_res=392,
        process_res_method="upper_bound_resize",
        ref_view_strategy="middle",
        export_dir=str(export_dir),
        export_format="mini_npz-glb",
    )
    torch.cuda.synchronize()
    inference_seconds = time.monotonic() - inference_started
    peak_vram_bytes = int(torch.cuda.max_memory_allocated())

    result_path = WORK_DIR / "result.npz"
    np.savez_compressed(
        result_path,
        depth=prediction.depth,
        confidence=prediction.conf,
        extrinsics=prediction.extrinsics,
        intrinsics=prediction.intrinsics,
    )
    preview_path = WORK_DIR / "depth-preview.png"
    make_depth_preview(prediction.depth[0], preview_path)
    ply_path = WORK_DIR / "canonical-preview.ply"
    cloud_meta = write_canonical_ply(prediction, ply_path)
    glb_paths = sorted(export_dir.glob("*.glb"))
    if not glb_paths:
        raise RuntimeError("DA3 did not produce the requested native GLB preview")
    glb_path = glb_paths[0]
    worker_report = {
        "schema_version": "mvl.mvl029-demo-report/0.1.0",
        "task_id": plan["task_id"],
        "run_profile": plan["run_profile"],
        "model_key": model_key,
        "model": model_spec,
        "source_key": source_key,
        "source": {
            **source_spec,
            "input_transport": "gcs_window_object" if input_gcs_uri else "remote_url",
            "source_duration_seconds": source_duration,
            "frame_count": len(frames),
            "frame_sha256": frame_hashes,
            "clip_identity_sha256": clip_identity,
        },
        "measurements": {
            "wall_seconds": time.monotonic() - started,
            "inference_gpu_seconds": inference_seconds,
            "peak_vram_bytes": peak_vram_bytes,
        },
        "artifacts": [
            {"artifact_id": "raw-depth-pose-result", "path": result_path.name, "sha256": sha256_file(result_path), "size_bytes": result_path.stat().st_size},
            {"artifact_id": "depth-preview", "path": preview_path.name, "sha256": sha256_file(preview_path), "size_bytes": preview_path.stat().st_size},
            {"artifact_id": "native-glb-preview", "path": glb_path.name, "sha256": sha256_file(glb_path), "size_bytes": glb_path.stat().st_size, "presentation_only": True},
            {"artifact_id": "canonical-point-cloud-preview", "path": ply_path.name, "sha256": sha256_file(ply_path), "size_bytes": ply_path.stat().st_size, "presentation_only": False, "metadata": cloud_meta},
        ],
        "pipeline": {
            "native_glb_role": "presentation_only",
            "canonical_cloud_role": "own_depth_backprojection_preview",
            "height_claim": "unknown_without_independent_registered_canopy_and_soil_truth",
        },
        "runtime_model_registry": {
            "checkpoint_acquisition": "disabled",
            "offline_environment": {
                "HF_HUB_OFFLINE": os.environ["HF_HUB_OFFLINE"],
                "TRANSFORMERS_OFFLINE": os.environ["TRANSFORMERS_OFFLINE"],
            },
            "credential_environment_names_present": [],
        },
        "selection": plan["selection"],
        "image_digest": image_digest,
        "billed_runtime_ceiling_seconds": plan["limits"]["max_gpu_seconds"],
        "non_acceptance": plan["non_acceptance"],
    }
    report_path = WORK_DIR / "worker-report.json"
    report_path.write_text(json.dumps(worker_report, indent=2, sort_keys=True) + "\n")

    from google.cloud import storage

    client = storage.Client()
    bucket = client.bucket(bucket_name)
    upload_paths = [result_path, preview_path, glb_path, ply_path, report_path]
    for path in upload_paths:
        blob = bucket.blob(f"{output_prefix}{model_key}/{path.name}")
        blob.upload_from_filename(path, if_generation_match=0)
    emit("completed", model_key=model_key, output_prefix=output_prefix, elapsed_seconds=round(time.monotonic() - started, 3))


if __name__ == "__main__":
    main()
