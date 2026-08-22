# syntax=docker/dockerfile:1
# super-silly: SillyTavern + Ollama + Autolife in one container.
#
# Build from the repo root:
#   docker build -f docker/Dockerfile -t supersilly:latest .
#
# Ubuntu base because Ollama needs glibc (no Alpine). GPU optional at run time:
#   docker run --gpus all ...   (NVIDIA; needs nvidia-container-toolkit on the host)

ARG ST_REF=release
# Global-scope ARG so the ollama stage can be pinned/overridden at build time:
#   docker build --build-arg OLLAMA_IMAGE=ollama/ollama:<tag> ...
ARG OLLAMA_IMAGE=ollama/ollama:latest
# llama.cpp server stage. PIN TO THE CUDA-12 FLAVOR: CUDA 13 toolchains cannot
# target Pascal (sm_61, Tesla P40). The CUDA-12 default arch list includes 61.
ARG LLAMACPP_IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda

# ---- Stage 0a: llama.cpp server binary + CUDA runtime libs ----
# (BuildKit does not support variable expansion in COPY --from directly —
# hence this named stage, same trick as the ollama one.)
FROM ${LLAMACPP_IMAGE} AS llamacpp-src

# ---- Stage 0b: ollama binary + runners (CPU/CUDA) ----
# Binary must live at /bin/ollama (as upstream): runner discovery resolves the
# library root relative to the binary, and /bin -> / -> /lib/ollama hits
# /usr/lib/ollama via Ubuntu's merged-usr layout.
# (BuildKit does not support variable expansion in COPY --from directly —
# hence this named stage. Remember: compose build does NOT re-pull base
# images; `docker pull ollama/ollama:latest` first when updating.)
FROM ${OLLAMA_IMAGE} AS ollama-src

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
    && apt-get install -y --no-install-recommends ca-certificates curl tini libopenblas0 libvulkan1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Ollama binary + runners from the pinned stage above.
COPY --from=ollama-src /bin/ollama /bin/ollama
COPY --from=ollama-src /usr/lib/ollama /usr/lib/ollama

# llama.cpp server for the AUTOLIFE_BACKEND=llamacpp mode (Qwen3.5 / Dark-Scarlett,
# top_n_sigma + XTC samplers). Copy /app wholesale — the binary resolves its
# libggml/libllama .so siblings via rpath $ORIGIN, so it must keep them beside
# it (PATH gets /app). The CUDA runtime libs come along too: the binary links
# against libcudart/libcublas, which nvidia-container-toolkit does NOT inject
# (it provides driver libs only). Compose `docker pull` note applies here too:
# re-pull ghcr.io/ggml-org/llama.cpp:server-cuda before rebuilding.
COPY --from=llamacpp-src /app /app
COPY --from=llamacpp-src /usr/local/cuda/lib64 /usr/local/cuda/lib64
# NCCL runtime the CUDA ggml lib links against (Ubuntu universe ships a
# different build; take the exact one from the llama.cpp image)
COPY --from=llamacpp-src /usr/lib/x86_64-linux-gnu/libnccl.so.2* /usr/lib/x86_64-linux-gnu/
# /app on LD_LIBRARY_PATH: the binary ships without an rpath, so its
# libggml/libllama siblings resolve via the loader path instead.
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:/app \
    PATH="/app:${PATH}"

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

VOLUME ["/home/node/app/config", "/home/node/app/data", "/root/.ollama", "/models"]
EXPOSE 8000
ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
