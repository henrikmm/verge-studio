FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir \
      xformers==0.0.28.post3 \
      google-cloud-storage==2.19.0 \
      yt-dlp \
      "git+https://github.com/ByteDance-Seed/Depth-Anything-3.git@3d835ec1a5802d64a8b8b15f817a1ab54809bfe4"

COPY download-models.py /tmp/download-models.py
RUN python /tmp/download-models.py && rm /tmp/download-models.py

WORKDIR /app
COPY plan.json /app/plan.json
COPY runner.py /app/runner.py

ENV PYTHONUNBUFFERED=1
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENTRYPOINT ["python", "/app/runner.py"]
