# syntax=docker/dockerfile:1
# ReplayBox AppImage builder — Ubuntu 22.04 LTS (glibc 2.35 baseline).
# Repository is bind-mounted at /work at runtime; only entrypoint is copied here.

FROM ubuntu:22.04

LABEL org.replaybox.appimage-builder=1

ENV DEBIAN_FRONTEND=noninteractive \
    NO_STRIP=true \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:${PATH}"

# apt — single layer; invalidates only when package list changes.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      file \
      git \
      gstreamer1.0-libav \
      gstreamer1.0-plugins-bad \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-ugly \
      gstreamer1.0-tools \
      libayatana-appindicator3-dev \
      libfuse2 \
      libgstreamer-plugins-base1.0-dev \
      libgstreamer1.0-dev \
      libgtk-3-dev \
      librsvg2-bin \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libx264-dev \
      nasm \
      patchelf \
      pkg-config \
      wget \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS — Ubuntu apt ships Node 12; Tauri 2 / Vite 7 require Node 20+.
ARG NODE_MAJOR=20
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

# rustup — separate layer; invalidates only when RUST_VERSION changes.
ARG RUST_VERSION=stable
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | env RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
        sh -s -- -y --default-toolchain "${RUST_VERSION}" --profile minimal \
    && chmod -R a+rX /usr/local/rustup /usr/local/cargo \
    && rustc --version \
    && cargo --version

COPY docker/appimage/entrypoint.sh /usr/local/bin/replaybox-appimage-entrypoint
RUN chmod +x /usr/local/bin/replaybox-appimage-entrypoint

WORKDIR /work
ENTRYPOINT ["replaybox-appimage-entrypoint"]
