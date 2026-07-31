import argparse
import hashlib
from pathlib import Path

from huggingface_hub import snapshot_download


MODELS = [
    (
        "depth-anything/DA3NESTED-GIANT-LARGE-1.1",
        "b2359bdf726fb44ef62acca04d629dcf158053e7",
        "/opt/mvl-models/da3_nested_giant_large_1_1",
        "model.safetensors",
        "8ebe871a022ed58d2fc8fdfb2ebdb31d57b60fe39611c849095851a7b7c6020c",
        6759558100,
    ),
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model(model: tuple[str, str, str, str, str, int]) -> None:
    _, revision, local_dir, checkpoint_filename, expected_sha256, expected_size = model
    checkpoint = Path(local_dir) / checkpoint_filename
    if not checkpoint.is_file():
        raise RuntimeError(f"missing baked checkpoint for revision {revision}: {checkpoint}")
    actual_size = checkpoint.stat().st_size
    if actual_size != expected_size:
        raise RuntimeError(
            f"checkpoint size mismatch for revision {revision}: "
            f"expected {expected_size}, got {actual_size}"
        )
    actual_sha256 = sha256_file(checkpoint)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"checkpoint checksum mismatch for revision {revision}: "
            f"expected {expected_sha256}, got {actual_sha256}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="verify the selected checkpoint already baked into an image",
    )
    args = parser.parse_args()

    for model in MODELS:
        if not args.verify_only:
            repo_id, revision, local_dir, _, _, _ = model
            snapshot_download(
                repo_id=repo_id,
                revision=revision,
                local_dir=local_dir,
                allow_patterns=["*.json", "model.safetensors"],
            )
        verify_model(model)


if __name__ == "__main__":
    main()
