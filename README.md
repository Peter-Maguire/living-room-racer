# Living-Room Racer

Online multiplayer, top-down 3D toy car racing game (Micro Machines style) with free-driving physics, predefined tracks, and Mario Kart–style off-track recovery.

See [`plan.md`](./plan.md) for the full technical design.

## Monorepo layout

```
packages/
  shared/   # physics step, track schema, message schemas, constants (client + server share this)
  server/   # authoritative Node + socket.io game server (one process per match)
  client/   # three.js + Vite browser client
infra/      # CloudFormation templates + deploy scripts (see infra/README.md)
```

## Prerequisites

- Node.js >= 20
- pnpm 9 (`corepack enable` then `corepack prepare pnpm@9.12.0 --activate`)
- For infra: AWS CLI v2 and AWS SAM CLI, with credentials configured

## Getting started

```bash
pnpm install
pnpm build          # build all packages
pnpm typecheck      # typecheck all packages

pnpm dev:server     # run the game server locally
pnpm dev:client     # run the Vite dev server for the client
```

Local development connects the client directly to `http://localhost:3001`; it does **not** require GameLift, Docker, or AWS credentials. The local defaults live in `packages/client/.env` and `packages/server/.env` (copy the corresponding `.env.example` files if they are missing).

`infra/scripts/outputs.ps1` and `outputs.sh` generate `packages/client/.env.production` for deployment builds. Do not run the GameLift wrapper or its Docker image for ordinary local play: those are for the managed GameLift container fleet. GameLift Anywhere requires a separate Anywhere-specific wrapper configuration.

## Graphics and dev options

The client is art-free by default: textures, toy cars and the living-room props are generated in code (`packages/client/src/gfx/`). Optional URL parameters:

| Parameter | Effect |
|-----------|--------|
| `?debug` | Frame time, draw calls, triangles and texture counts in the corner. |
| `?gfx=low` | No shadows, scenery, particles or skid marks; pixel ratio 1. For low-end machines. |
| `?cam=follow` | Close camera on your car (handy for inspecting models and effects). |

To use real art, drop a `car.glb` into `packages/client/public/assets/` — see the contract in that folder's README. A missing or broken file falls back to the built-in car.

Testing helpers: `pnpm --filter @racer/shared validate` (track, physics and item rules), `pnpm --filter @racer/client e2e:items` (every item end to end over real sockets), `node packages/client/scripts/run-bots.mjs --port 3001` (scripted opponents), and `FORCE_ITEM=oil` on the server (every pad gives that item).

## Infrastructure

All AWS resources are defined in CloudFormation under `infra/`. See [`infra/README.md`](./infra/README.md) for the from-scratch bootstrap and the local iteration loop.
