# Living-Room Toy Car Racing — Technical Plan

An online multiplayer, top-down 3D racing game in the spirit of Micro Machines: small cars racing on **predefined tracks** laid out across a living-room / tabletop scene (books, pencils, rugs, cereal boxes as scenery). Cars **drive freely** with full steering and drift — they are **not** locked to a rail. Driving off the track triggers a **Mario Kart–style recovery**: the car is caught, respawned on the track at the last valid point, and briefly re-dropped with a short control lockout.

- 2–8 players per race, lap-based (3–5 laps).
- Server-authoritative simulation with client-side prediction and reconciliation.
- three.js rendering, socket.io + Node.js networking, AWS GameLift hosting + FlexMatch matchmaking.

---

## 1. Core Design Decisions

**Free-driving physics, predefined tracks.** Cars have full throttle/steer/brake/drift. Tracks are hand-authored: a drivable surface mesh, invisible walls or a track boundary, ordered checkpoints, spawn grid, and a recovery spline. The track is fixed content, not procedurally generated.

**Off-track recovery (Mario Kart style).** The track defines a **drivable area** (a polygon/mask or a collision surface tagged "on-track") and a **recovery path** (the racing-line spline plus per-segment respawn transforms). When a car leaves the drivable area (or falls off the table edge):
1. The server detects "off-track" (car center outside the drivable mask for N ticks, or below a fall threshold).
2. The car enters a **RECOVERING** state: physics body is frozen, control input ignored.
3. A "claw/hand" (visual only) lifts the car; after a short delay it is placed at the **nearest valid recovery point behind the car's last on-track checkpoint progress**, facing along the racing line.
4. A brief **control lockout + invulnerability** window, then the car returns to RACING.
5. Recovery costs time (the whole point) but never a lap of progress — checkpoint progress is preserved.

**Server owns everything.** Positions, collisions, lap counting, off-track detection, recovery, item spawns, and finish order are all authoritative on the server. Clients send inputs and predict locally.

---

## 2. Technology Stack

### Client (browser)
- **three.js** — rendering (steep top-down perspective or orthographic camera).
- **TypeScript** — shared types across client/server.
- **Vite** — dev server + bundler.
- **socket.io-client** — realtime transport.
- **Rapier (@dimforge/rapier3d, WASM)** — client-side physics for prediction; same engine as the server.
- **howler.js** — audio (engine loop, collisions, recovery whoosh, countdown).
- Plain DOM/CSS (or a light React layer) for menus, lobby, and HUD.

### Server (game simulation)
- **Node.js (LTS) + TypeScript** — authoritative game server, one process per match.
- **socket.io** — messaging; socket.io rooms map 1:1 to matches.
- **Rapier (rapier3d-compat / native bindings)** — authoritative physics, identical to the client.

### Shared code (monorepo)
- **pnpm workspaces** — a `shared` package with: the physics step, track data schema, checkpoint/recovery logic, message schemas, and tuning constants used by both client and server. This is what makes prediction and reconciliation match.
- **zod** for message validation to start; **flatbuffers** later if bandwidth needs shrinking.

### Backend services (AWS)
- **AWS GameLift** — fleet hosting for the Node game servers.
- **GameLift FlexMatch** — matchmaking rules and ticketing.
- **Amazon Cognito** — player identity (guest + registered).
- **API Gateway + AWS Lambda** — HTTP layer: auth, matchmaking ticket creation, profiles, leaderboards.
- **DynamoDB** — profiles, cosmetics, match history, leaderboards.
- **S3 + CloudFront** — host the client bundle and game assets.
- **CloudWatch** — logs, metrics, alarms.

### Tooling / infra
- **Docker** — package the Node game server for GameLift.
- **AWS CloudFormation** — infrastructure as code; nested stacks deployed from a local script (see Section 14).
- **AWS CLI + SAM CLI** — local deployment and packaging of templates and Lambda code.
- **GitHub Actions** — CI/CD: build client, build server image, deploy GameLift build + fleet via the same CloudFormation stacks.
- **GameLift Anywhere** — run the server SDK integration locally during development.

---

## 3. Architecture Overview

```
                    ┌─────────────────────────────────────────┐
                    │              Player Browser               │
                    │  three.js render · Rapier prediction ·    │
                    │  socket.io-client · lobby + HUD           │
                    └───────┬───────────────────────┬──────────┘
                            │ HTTPS (auth,           │ WebSocket (socket.io):
                            │ matchmaking ticket)    │ inputs ↑  snapshots ↓
                            ▼                        │
          ┌──────────────────────────────┐          │
          │ API Gateway + Lambda          │          │
          │  Cognito auth · StartMatchmaking│        │
          │  profiles · leaderboards       │          │
          └──────┬───────────────┬────────┘          │
                 ▼               ▼                    ▼
          ┌───────────┐   ┌──────────────┐   ┌──────────────────────────┐
          │ DynamoDB  │   │  GameLift     │   │  GameLift Fleet           │
          │           │   │  FlexMatch    │──▶│  Node game server / match │
          └───────────┘   └──────────────┘   │  Rapier sim @ 30–60Hz     │
                                              │  off-track + recovery     │
                                              │  socket.io room = match   │
                                              └──────────────────────────┘
```

---

## 4. Networking Model

Server-authoritative with client-side prediction, reconciliation, and entity interpolation:

1. **Input** — client samples input (throttle, steer, brake, drift, item) at a fixed tick, stamps a sequence number, sends to server (~30–60 Hz).
2. **Server sim** — authoritative Rapier step at a fixed timestep (start **30 Hz**). Applies buffered inputs, resolves collisions, runs off-track/recovery logic, produces true state.
3. **Snapshots** — server broadcasts state (car transforms, velocities, car state = RACING/RECOVERING, lap/checkpoint progress, race phase) at ~15–20 Hz, each acking the last processed input sequence per player.
4. **Prediction** — the local car is simulated immediately with the shared physics code so control feels instant.
5. **Reconciliation** — on snapshot, rewind to the acked input, snap to server state, replay unacked inputs. Shared Rapier step keeps corrections tiny.
6. **Interpolation** — remote cars rendered ~100 ms in the past, interpolated between snapshots.

**Recovery over the network:** recovery is fully server-driven. When the server flags a car RECOVERING, the client stops predicting that car and plays the recovery animation to the server-provided respawn transform. This avoids the client and server disagreeing about where a fallen car ends up.

**Transport:** socket.io over WebSocket/TCP is acceptable at these tick rates with an interpolation buffer; keep messages small and consider binary encoding later.

---

## 5. Track & Recovery Data Model

A track is authored content (JSON + meshes) in the `shared` package:

- **Render mesh** — the visual track + living-room scenery (GLTF, Draco-compressed, instanced props).
- **Collision mesh** — walls, curbs, table edges.
- **Drivable mask** — the "on-track" surface used for off-track detection (a polygon set, a heightmap tag, or a tagged collision surface).
- **Checkpoints** — ordered volumes around the loop; a lap counts only when all are hit in order (prevents shortcutting). Start/finish is a checkpoint.
- **Racing-line spline** — the recovery path; sampled into per-segment respawn transforms (position + facing).
- **Spawn grid** — starting-grid transforms for up to 8 cars.
- **Fall threshold** — a Y height below which a car counts as fallen off the table.

Recovery lookup: given a car's last passed checkpoint, find the nearest recovery-spline sample at or behind that progress and respawn there facing forward.

---

## 6. Authoritative Simulation

- **Fixed timestep** loop (accumulator) so physics is deterministic regardless of frame jitter.
- **Shared `stepWorld(state, inputs, dt)`** compiled to both Node and browser WASM; same Rapier version, colliders, and constants on both sides.
- **Car state machine:** `COUNTDOWN → RACING ⇄ RECOVERING → FINISHED`.
- **World state** compact and serializable: car transforms + velocities + state, item/pickup states, per-player checkpoint/lap progress, race clock, race phase.
- **Determinism:** Rapier is deterministic given identical inputs and step order — the reason it's chosen for the authoritative path.

---

## 7. Lobby & Matchmaking Flow

1. Player authenticates via Cognito (guest login for quick play).
2. Client calls `StartMatchmaking` (API Gateway → Lambda → FlexMatch) with party size, region latencies, optional skill, and game mode.
3. FlexMatch groups 2–8 players (single "racers" team), using latency rules per region and expansion rules that relax over time so nobody waits forever.
4. On success, the client receives game-session connection info (IP, port) and a **player session ID**.
5. Client connects to the Node server via socket.io, presenting the player session ID; the server validates it with GameLift (`AcceptPlayerSession`).
6. Players enter a **pre-race lobby room** (socket.io room = match): ready-up, car/skin select, countdown. When all ready or the timer expires, the server starts the race.

Optional pre-race **backfill** to fill empty slots; disabled once the race begins.

---

## 8. AWS GameLift Integration

- **Server SDK (Node.js)** lifecycle in the game server:
  - `InitSDK()` on boot.
  - `ProcessReady({ port, onStartGameSession, onProcessTerminate, onHealthCheck })`.
  - `onStartGameSession` → build the match room → `ActivateGameSession()`.
  - `AcceptPlayerSession` on connect; `RemovePlayerSession` on disconnect.
  - `TerminateGameSession()` + `ProcessEnding()` at race end to free the slot.
- **Fleets:** multiple server processes per instance (one per match) to pack instances; size the instance to the Rapier step cost and load test.
- **Queue + alias:** multi-region queue for latency-based placement; a fleet alias to swap builds without touching client config.
- **Scaling:** target-based auto-scaling on percent-available game sessions; keep spare capacity so matches start instantly.
- **Local dev:** GameLift Anywhere to test SDK integration before deploying a fleet.

---

## 9. Security & Fair Play

- Server-authoritative positions, collisions, laps, off-track detection, recovery, items, and finish order.
- Validate player session IDs against GameLift; reject unknown sockets.
- Range-check and rate-limit inputs; ignore impossible sequences.
- Cognito tokens on the HTTP layer; scoped IAM for the game server (GameLift + result-write only).
- Never trust client-reported scores for leaderboards.

---

## 10. Rendering (three.js)

- **Camera:** steep top-down perspective or orthographic; either a per-player follow cam or a shared framed cam (Micro Machines style).
- **Cars:** low-poly GLTF, instanced; wheel spin driven by interpolation; drift particles and skid decals.
- **Scenery:** instanced living-room props, baked lighting where possible for browser performance.
- **Recovery visual:** a claw/hand or "picked up and re-dropped" animation matching the server recovery state.
- **HUD:** lap counter, position, timer, minimap, item slot — DOM/CSS overlay.
- **Assets:** GLTF + Draco, texture atlases, served from S3/CloudFront.

---

## 11. Data & Persistence

- **DynamoDB:** `Players` (profile, cosmetics, MMR), `MatchHistory` (per-race results), `Leaderboards` (best lap per track, wins) with a score-sorted GSI.
- **Match results:** the game server posts authoritative results at race end (via Lambda or scoped direct writes) for persistence and MMR updates.
- **Cosmetics:** unlocked skins per player, validated server-side at car select.

---

## 12. Prioritized Work Outline

Ordered so you reach a playable multiplayer loop before touching AWS, then integrate hosting, then polish. Each phase produces something demoable.

### P0 — Foundations (must do first)
1. Monorepo with pnpm workspaces: `client`, `server`, `shared`. TypeScript + Vite configured.
2. Extract a `shared` physics package early: `stepWorld(state, inputs, dt)` with a fixed timestep, wired to Rapier (WASM for client, native/compat for server).
3. Define the message schema (zod) and shared constants/tuning.

### P1 — Single-player driving prototype (local, no server)
4. three.js scene with a top-down camera and one drivable car using the shared physics.
5. Car handling feel: throttle, steer, brake, drift tuning.
6. Author a first **predefined track**: render mesh, collision mesh, drivable mask, checkpoints, racing-line spline, spawn grid. A blockout is fine.
7. **Off-track detection + Mario Kart recovery** implemented in shared physics (RACING ⇄ RECOVERING, freeze → lift → respawn on racing line → lockout). This is a defining feature — do it early.
8. Lap/checkpoint counting and a lap timer.

### P2 — Multiplayer core (localhost)
9. Node + socket.io authoritative server running the shared sim at a fixed tick; one hardcoded match.
10. Input send → server sim → snapshot broadcast.
11. Client-side prediction + reconciliation for the local car.
12. Entity interpolation for remote cars.
13. Server-driven recovery synced to clients (client stops predicting a RECOVERING car, plays animation to server respawn transform).
14. Goal: two browsers racing the same track over localhost with clean recovery.

### P3 — Race lifecycle & lobby
15. Race phases: countdown → racing → finish, with server-authoritative finish order and results.
16. Pre-race lobby room (socket.io room): join, ready-up, car/skin select, start.
17. Results screen; return-to-lobby / rematch flow.

### P4 — AWS GameLift + matchmaking
18. Integrate the GameLift Server SDK lifecycle into the game server; test with GameLift Anywhere.
19. Cognito auth + API Gateway/Lambda for login and `StartMatchmaking`.
20. FlexMatch rule set (2–8 players, latency, expansion); GameLift queue + fleet + alias.
21. Client matchmaking flow: ticket → poll → connect with player session ID → validate server-side.
22. Infrastructure as code (CDK/Terraform); GitHub Actions CI/CD to build and deploy.
23. Auto-scaling config and a first load test.

### P5 — Content, progression & polish
24. Additional tracks and the track-authoring workflow.
25. Items / power-ups (server-authoritative spawns and effects).
26. DynamoDB persistence: profiles, match history, leaderboards; MMR updates.
27. Audio (howler.js), particles, skid decals, recovery animation polish.
28. Performance pass: instancing, Draco, baked lighting, particle caps; browser perf testing.
29. Cosmetics/unlocks and account progression.

### Cross-cutting (do continuously)
- Keep client and server physics byte-for-byte identical via the shared package — the top defense against rubber-banding.
- Metrics/logging (CloudWatch) from P4 onward.
- Playtest handling and recovery feel every phase; they define the game.

---

## 13. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Client/server physics divergence | Constant rubber-banding | One shared Rapier step, identical constants, deterministic fixed timestep |
| Recovery feels bad or disagrees across clients | Frustrating, breaks trust | Server-authoritative recovery; client only animates to the server respawn transform |
| Off-track detection false positives (curbs, edges) | Unfair recoveries | Tune the drivable mask + require off-track for N ticks + grace on curbs |
| socket.io/TCP latency | Jittery remote cars | Interpolation buffer, small/binary messages, modest tick rates |
| GameLift integration slips timeline | Missed milestone | Start P4 early with GameLift Anywhere; isolate SDK behind a thin adapter |
| Browser perf on low-end machines | Poor experience | Instancing, Draco, baked lighting, capped particles |

---

## Technology Summary

**Given constraints:** three.js, socket.io, Node.js, AWS GameLift, lobby/matchmaking.

**Additional technologies in this plan:** TypeScript, Vite, Rapier (shared client+server physics), pnpm workspaces, zod (later flatbuffers), GameLift FlexMatch, Amazon Cognito, API Gateway + Lambda, DynamoDB, S3 + CloudFront, CloudWatch, Docker, AWS CDK/Terraform, GitHub Actions, GameLift Anywhere, howler.js.

---

## 14. Infrastructure Deployment (CloudFormation)

Goal: **stand up the entire backend from scratch with one command**, and then **iterate on individual pieces locally with fast, cheap redeploys**. Everything is CloudFormation so there is a single source of truth, no drift between "what I ran locally" and "what CI runs," and a clean teardown.

### 14.1 Principles

- **One tool, one source of truth.** All AWS resources are defined in CloudFormation templates checked into the repo. Local deploys and CI deploys run the *same* templates with different parameter values.
- **From-scratch is a first-class path.** A single script bootstraps a brand-new AWS account/region into a fully working environment.
- **Fast inner loop.** Day-to-day you should rarely redeploy everything. Split the system so the things that change often (Lambda code, game-server build, client bundle) deploy in seconds without touching slow/stateful resources (Cognito, DynamoDB, GameLift fleets).
- **Environment = parameters, not copies.** `dev`, `staging`, `prod` are the same templates with a different `EnvName` parameter and parameter file. No forked YAML per environment.
- **Nothing manual in the console.** If it exists in AWS, it exists in a template. The console is read-only for humans.

### 14.2 Stack layout (nested stacks)

Split by change frequency and lifecycle so you never wait on a GameLift fleet to update a Lambda. A root stack wires them together via nested stacks and cross-stack outputs.

```
infra/
  templates/
    root.yaml                # parent stack: references the nested stacks below
    network.yaml             # VPC, subnets, security groups (if needed for fleets)
    data.yaml                # DynamoDB tables (Players, MatchHistory, Leaderboards) + GSIs
    identity.yaml            # Cognito user pool, identity pool, app clients
    api.yaml                 # API Gateway + Lambda (auth, matchmaking, profiles, leaderboards)
    matchmaking.yaml         # GameLift FlexMatch matchmaking config + rule set
    gamelift.yaml            # GameLift build, fleet, alias, queue, scaling policy
    web.yaml                 # S3 bucket + CloudFront distribution for the client
    observability.yaml       # CloudWatch dashboards, alarms, log groups
  params/
    dev.json
    staging.json
    prod.json
  scripts/
    deploy.sh                # deploy/update one or all stacks (local + CI)
    bootstrap.sh             # from-scratch: artifact bucket, then full deploy
    teardown.sh              # delete everything for an env
    outputs.sh               # dump stack outputs into client/server .env files
```

**Lifecycle tiers (roughly slowest/most-stateful → fastest/most-disposable):**

| Tier | Stacks | Change frequency | Notes |
|------|--------|------------------|-------|
| Foundational / stateful | `network`, `data`, `identity` | Rarely | Deletion-protected in prod; you almost never tear these down |
| Platform | `api`, `matchmaking`, `web`, `observability` | Occasionally | Lambda code changes often but goes through packaged deploys (below) |
| Compute build | `gamelift` | Per server build | New game-server build → new GameLift build resource → fleet points at it via alias |

Keeping `data` and `identity` in their own stacks means a bad deploy elsewhere can't accidentally delete your user pool or tables.

### 14.3 Handling the parts CloudFormation doesn't do natively

- **Lambda + Layer code** needs to be zipped and uploaded before the stack can reference it. Use **AWS SAM** (`sam build` + `sam deploy`) or `aws cloudformation package` to upload code to an artifact S3 bucket and rewrite the template with the real S3 URIs. SAM also gives you `sam local invoke` for testing Lambdas without deploying.
- **GameLift builds** are uploaded outside the template with `aws gamelift upload-build` (or `create-build` + S3), which returns a **build ID**. That build ID is passed into `gamelift.yaml` as a parameter, so the fleet definition stays declarative while the binary upload is a scripted step.
- **Client bundle** is a Vite build synced to the `web` S3 bucket, followed by a CloudFront invalidation. This is content, not infrastructure, so it's a script step (`aws s3 sync` + `create-invalidation`), not a stack update.

### 14.4 From-scratch bootstrap (one command)

`scripts/bootstrap.sh <env>` does, in order:

1. **Preflight:** verify AWS CLI + SAM CLI installed and credentials/region set; confirm the target account is expected (guard against deploying dev config to prod).
2. **Artifact bucket:** create (or confirm) an S3 bucket for packaged Lambda code and templates — the one thing that must exist before CloudFormation can package anything.
3. **Package:** `sam build` then `aws cloudformation package` to upload Lambda/layer artifacts and produce a fully-resolved `root.packaged.yaml`.
4. **Deploy foundational + platform stacks:** `deploy.sh` the root stack with `params/<env>.json`. This creates VPC (if used), DynamoDB, Cognito, API Gateway, Lambdas, FlexMatch config, S3/CloudFront, and observability.
5. **Game-server build + fleet:** build the Docker/Node server, `upload-build`, capture the build ID, deploy `gamelift.yaml` with that build ID.
6. **Wire outputs:** `outputs.sh` writes stack outputs (Cognito IDs, API URL, CloudFront domain, GameLift queue name) into `client/.env` and `server/.env`.
7. **Publish client:** build the client and `s3 sync` + invalidate.

Result: a working environment in one command. The same steps run in CI for `staging`/`prod`.

### 14.5 The local iteration loop (the important part)

Most changes touch one tier. Deploy only that tier:

- **Editing Lambda/API logic** (most common): `sam build && sam deploy` (or `deploy.sh api <env>`). Seconds, no touch to Cognito/DynamoDB/GameLift. Use `sam local invoke` / `sam local start-api` to test handlers before deploying at all.
- **Editing the game server** (physics, netcode): iterate **locally first** with **GameLift Anywhere** — register your dev machine as an Anywhere fleet host and run the Node server against real FlexMatch without a managed EC2 fleet. Only when you need a hosted build do you `upload-build` + `deploy.sh gamelift <env>`.
- **Editing the client:** pure `vite dev` locally against the deployed API/Cognito; publish with `s3 sync` + invalidation when you want it live. No stack update.
- **Editing infra (a table, an alarm, a rule set):** edit the one template, `deploy.sh <stack> <env>`. **Always run `aws cloudformation deploy --no-execute-changeset` (a change set) first** to preview exactly what will change, add/replace, or *delete* before it happens — critical for stateful stacks.

Rule of thumb: **code changes → packaged deploy or local emulation; infra changes → targeted change-set deploy; full `bootstrap.sh` only for a new account/region or a clean-room test.**

### 14.6 Safety rails

- **Change sets before stateful updates.** Preview and require confirmation for `data`/`identity` changes; a surprise "Delete DynamoDB table" should never execute silently.
- **`DeletionPolicy: Retain`** on DynamoDB tables, Cognito pools, and the artifact/web buckets so a stack delete can't nuke player data. **`UpdateReplacePolicy: Retain`** likewise.
- **Termination protection** on foundational stacks in `staging`/`prod`.
- **Stack policies** that deny updates to stateful resources unless explicitly overridden.
- **Least-privilege deploy role.** The CI/local deploy role gets scoped permissions; the game server's runtime role gets only GameLift + result-write.
- **Drift detection** run periodically (and in CI) to catch any manual console changes — which should be none.

### 14.7 Teardown

`scripts/teardown.sh <env>` deletes the stacks in reverse dependency order (`gamelift` → platform → foundational). Retained resources (tables, user pool, buckets) survive by policy and are cleaned up explicitly only when you truly mean it. This makes clean-room "does bootstrap really work from nothing?" testing cheap and repeatable — spin a throwaway env up and down at will.

### 14.8 Why CloudFormation here (vs. CDK/Terraform)

You asked for CloudFormation specifically, and it fits: it's the native AWS IaC, needs no extra state backend (unlike Terraform's state file) or synth step, and integrates directly with GameLift, FlexMatch, and Cognito resource types. SAM sits on top of CloudFormation to smooth over the Lambda packaging gap without introducing a second tool. If the team later wants higher-level abstractions, CDK *synthesizes to CloudFormation*, so this layout remains the deployment target — nothing is wasted.

### 14.9 Work outline additions (folds into Section 12, P4)

Do these as part of P4 (AWS integration), roughly in this order:

1. `data.yaml` + `identity.yaml` (DynamoDB, Cognito) with retain policies; deploy to `dev`.
2. `api.yaml` with SAM for the auth + matchmaking Lambdas; `sam local` test, then deploy.
3. `matchmaking.yaml` FlexMatch rule set + config.
4. `gamelift.yaml` build/fleet/alias/queue/scaling; wire `upload-build` into `deploy.sh`.
5. `web.yaml` S3 + CloudFront; client publish script.
6. `observability.yaml` dashboards + alarms.
7. `root.yaml` nesting + cross-stack outputs; `bootstrap.sh`, `deploy.sh`, `outputs.sh`, `teardown.sh`.
8. GitHub Actions calling the same scripts for `staging`/`prod`.
9. Prove it: run `teardown.sh dev` then `bootstrap.sh dev` in a clean account to confirm from-scratch works.
