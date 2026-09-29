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

## Infrastructure

All AWS resources are defined in CloudFormation under `infra/`. See [`infra/README.md`](./infra/README.md) for the from-scratch bootstrap and the local iteration loop.
