FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# No ffmpeg and no yt-dlp: frame extraction is local-first (the Mac does it) and the
# cloud never resolves or downloads video.
RUN python -m pip install --no-cache-dir \
      xformers==0.0.28.post3 \
      google-cloud-storage==2.19.0 \
      "fastapi==0.115.6" \
      "uvicorn[standard]==0.34.0" \
      "python-multipart==0.0.20" \
      "git+https://github.com/ByteDance-Seed/Depth-Anything-3.git@3d835ec1a5802d64a8b8b15f817a1ab54809bfe4"

COPY download-models.py /tmp/download-models.py
RUN python /tmp/download-models.py && rm /tmp/download-models.py

WORKDIR /app
COPY contract.py vram.py main.py /app/

ENV PYTHONUNBUFFERED=1
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV PORT=8080

# Single worker: one L4, one model in VRAM. Concurrency for the live-telemetry
# endpoints comes from the event loop, not from extra workers.
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1
