# syntax=docker/dockerfile:1
# super-silly: SillyTavern + Ollama + Autolife in one container.
#
# Build from the repo root:
#   docker build -f docker/Dockerfile -t supersilly:latest .
#
# Ubuntu base because Ollama needs glibc (no Alpine). GPU optional at run time:
#   docker run --gpus all ...   (NVIDIA; needs nvidia-container-toolkit on the host)

ARG ST_REF=release

# ---- Stage 1: build SillyTavern (release branch) ----
FROM node:22-bookworm-slim AS st-build
ARG ST_REF
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${ST_REF}" https://github.com/SillyTavern/SillyTavern /st
WORKDIR /st
RUN npm ci --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts \
    && node docker/build-lib.js \
    && npm cache clean --force

# ---- Stage 2: final image ----
FROM ubuntu:24.04

ARG ST_REF
LABEL org.opencontainers.image.title="super-silly" \
      org.opencontainers.image.description="SillyTavern + Ollama + Autolife autonomous characters (Telegram texting sim)" \
      org.opencontainers.image.source="https://github.com/local/super-silly"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    ST_HOME=/home/node/app \
    OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_LIBRARY_PATH=/usr/lib/ollama \
    OLLAMA_MODEL=hf.co/ReadyArt/Dark-Scarlett-27B-v2.0-GGUF:Q4_K_M \
    OLLAMA_FALLBACK_MODEL=hf.co/ReadyArt/Dark-Desires-12B-v1.0-GGUF:Q4_K_M

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini libopenblas0 libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

ARG OLLAMA_IMAGE=ollama/ollama:latest

# Ollama binary + runners (CPU/CUDA) from the official image.
# Binary must live at /bin/ollama (as upstream): runner discovery resolves the
# library root relative to the binary, and /bin -> / -> /lib/ollama hits
# /usr/lib/ollama via Ubuntu's merged-usr layout.
# Rebuild with a pinned/newer image via:
#   docker pull ollama/ollama:latest
#   docker build --build-arg OLLAMA_IMAGE=ollama/ollama:<tag> ...
# (compose build does NOT re-pull base images on its own)
COPY --from=${OLLAMA_IMAGE} /bin/ollama /bin/ollama
COPY --from=${OLLAMA_IMAGE} /usr/lib/ollama /usr/lib/ollama

# Node runtime (bookworm glibc <= ubuntu 24.04 glibc, binary is compatible)
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

# SillyTavern from the build stage
COPY --from=st-build /st /home/node/app

# Autolife components + seeds
COPY plugin /autolife-seed/plugin
COPY ui /autolife-seed/ui
COPY cards/examples /autolife-seed/cards
COPY docker/seed /autolife-seed/seed
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && mkdir -p /home/node/app/config /home/node/app/data /home/node/app/plugins \
    && rm -f /home/node/app/config.yaml \
    && ln -s config/config.yaml /home/node/app/config.yaml \
    && cp -r /autolife-seed/plugin /home/node/app/plugins/autolife

VOLUME ["/home/node/app/config", "/home/node/app/data", "/root/.ollama"]
EXPOSE 8000
ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
