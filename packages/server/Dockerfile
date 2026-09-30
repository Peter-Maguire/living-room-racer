# Game server image for Amazon GameLift Servers managed CONTAINER fleets.
#
# Layout inside the image (/local/game):
#   gamelift-wrapper   - official Go wrapper; owns the GameLift lifecycle
#   config.yaml        - wrapper config; tells it how to launch our server
#   server/            - our bundled Node game server
#
# The wrapper is the entrypoint. It registers with GameLift, then launches
# `node server/index.js --port <assignedPort>` as a child process.
#
# Build from the REPO ROOT so the pnpm workspace is available:
#   docker build -f packages/server/Dockerfile -t racer-server .

# ---- stage 1: build the official GameLift game server wrapper (Go) ----------
# This mirrors the wrapper repo's Makefile `build` target, which matters:
#  - go.mod has a `replace` pointing at src/ext/gamelift-servers-server-sdk, so
#    the RELEASED Go server SDK zip must be downloaded and extracted there.
#  - the version must be injected via -ldflags; without it the wrapper reports
#    "vDEV" and the GameLift agent rejects the websocket handshake with 403.
FROM golang:1.25-bookworm AS wrapper
ARG WRAPPER_VERSION=1.3.0
ARG SERVER_SDK_VERSION=5.6.0
ARG SERVER_SDK_URL=https://github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/releases/download/v5.6.0/GameLift-Go-ServerSDK-5.6.0.zip
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /w
# The wrapper source is vendored at vendor/gamelift-wrapper (see README).
COPY vendor/gamelift-wrapper/src/ ./src/
RUN mkdir -p src/ext/gamelift-servers-server-sdk \
    && curl -sSL "$SERVER_SDK_URL" -o /tmp/sdk.zip \
    && unzip -q /tmp/sdk.zip -d src/ext/gamelift-servers-server-sdk
RUN CGO_ENABLED=0 GOOS=linux go build \
      -C src \
      -trimpath \
      -ldflags="-X 'github.com/amazon-gamelift/amazon-gamelift-servers-game-server-wrapper/internal.version=${WRAPPER_VERSION}'" \
      -o /out/gamelift-wrapper \
      .

# ---- stage 2: build our Node game server -----------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# Copy the workspace manifests and the two packages we need, then install with
# dev deps so typescript/tsc is available for the build.
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @racer/shared build && pnpm --filter @racer/server build
# Produce a self-contained production tree (no workspace symlinks).
RUN pnpm --filter @racer/server --prod deploy /out/server

# ---- stage 3: runtime -------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV HOME_DIR=/local/game
ENV NODE_ENV=production
ENV USE_GAMELIFT=true

# ca-certificates is REQUIRED: the wrapper is a statically linked Go binary that
# opens a TLS WebSocket to the GameLift agent. Without the system CA bundle it
# fails with "x509: certificate signed by unknown authority" and the fleet
# deployment goes IMPAIRED.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p $HOME_DIR
WORKDIR $HOME_DIR

COPY --from=wrapper /out/gamelift-wrapper ./gamelift-wrapper
COPY --from=build /out/server ./server
COPY packages/server/gamelift-config.yaml ./config.yaml
COPY packages/server/start-server.sh ./start-server.sh

RUN useradd -m gamescale && chown -R gamescale:gamescale $HOME_DIR && \
    chmod +x ./gamelift-wrapper ./start-server.sh
USER gamescale

# GameLift assigns the port; the wrapper passes it to our server via --port.
EXPOSE 37016
ENTRYPOINT ["/bin/sh", "-c", "./gamelift-wrapper"]
