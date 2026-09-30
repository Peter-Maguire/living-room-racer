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

---

## 15. Stretch Goals

Post-MVP polish and content. None of these are required for a playable race — they're the "makes it feel like a real game" layer. Each entry notes what already exists in the codebase and what actually has to change, since several of these are cheaper (or more expensive) than they first look.

**Implementation status** (details in each section's notes below may describe the pre-implementation state):

| Goal | Status |
|------|--------|
| 15.1 Car colours | Done: server-assigned by slot, sent in `LobbyState`. |
| 15.2 More tracks | Mostly done: Breakfast Bar, Toy Box, Desk Cable, Kitchen Tile Sprint and Bathmat Rally added via `tracks/build.ts`. `pnpm --filter @racer/shared build && pnpm --filter @racer/shared validate` checks authoring rules, surface physics, and drives every track headlessly. Not done: Sofa Cushion Canyon (banking) and Laundry Basket Loop (wall-ride), which need sim support beyond surfaces. |
| Surface grip | Done: per-section `surfaces` + `defaultSurface` on tracks; traction/steer/top-speed/slide per surface in `SURFACES` (constants.ts); snapshots carry `speed` so prediction stays exact while sliding. Feeds tyre-noise voicing (15.4). |
| 15.3 UI | Done except the chromatic-shift/edge-blur polish. |
| 15.4 Noises | Done (procedural). Sampled sfx via howler.js not started (no assets). |
| 15.5 Soundtrack | Done (procedural, stem-based). |
| 15.6 Power-ups | Not started. |
| 15.7 Real graphics | Shadows and track-fitted camera done; asset pipeline and art not started. |

### 15.1 Unique car colours, consistent across all players

Every car gets a distinct colour, and **all players see the same car as the same colour**. Consistency is the whole requirement — if each client picked colours locally, "the blue car cut me off" would mean nothing in voice chat.

**What already exists:** `joinMatchSchema` and `LobbyState.players[]` both carry a `carSkin` string, so there's already a per-player cosmetic channel on the wire. `RenderCar` in the renderer takes per-car render data.

**Approach — server assigns, never the client:**
- Keep a fixed **colour palette** in `shared` (8 entries, one per grid slot, chosen to stay distinguishable on the living-room backdrop and for colour-blind players — avoid a red/green-only pairing).
- On `addPlayer`, the server claims the lowest **free** palette index and stores it on the `Player`. Free-list rather than `players.size`, so a mid-lobby leave/join can't hand two cars the same colour.
- Broadcast it in `LobbyState` (extend the player entry with `colorIndex`, alongside the existing `carSkin`).
- Client builds a `playerId -> colour` map from `LobbyState` and applies it when constructing `RenderCar`s. Note that `CarState` in snapshots has no cosmetic fields and shouldn't get any — colour is static per player, so sending it every snapshot at 15–20 Hz is wasted bandwidth. Lobby state is the right channel.
- Show the colour in the lobby player list and on the results screen so the mapping is learnable before the race starts.

**Later:** let players *request* a preferred colour in the lobby, with the server arbitrating conflicts (first-come, loser gets the next free slot). Server still has the final say, which also keeps cosmetics unlock-validated per Section 11.

### 15.2 More tracks

More authored content using the existing track model — no schema changes required.

**Scope note:** all ideas below are deliberately **single-level**. Off-track detection is a `trackHalfWidth` corridor measured in **XZ only** (see `track.ts`), and `findRecoveryPoint` ranks candidates with `distSqXZ`, so any geometry that stacks two drivable surfaces in the same XZ footprint (bridges, over/under crossings) would read as on-track for both and could respawn a car on the wrong deck. Staying single-level keeps every track below pure content work. Elevation *changes* are fine; overlapping decks are not.

**Track ideas** (living-room / tabletop scale, in rough order of authoring difficulty):

| Track | Concept | Features |
|-------|---------|----------|
| **Coffee Table Oval** | *(exists)* Rounded rectangle on the tabletop | Baseline |
| **Rug Weave Eight** | *(exists)* Lemniscate across a rug | Self-crossing, flat |
| **Breakfast Bar Circuit** | Long straights down the counter, hairpins around plates and bowls | Top-speed track; tests boost balance |
| **Kitchen Tile Sprint** | Grid of tiles with a spilled-milk slick on one corner | First surface-grip variation |
| **Toy Box Scramble** | Scattered building blocks as chicanes, very tight hairpins | Technical, low-speed, collision-heavy |
| **Sofa Cushion Canyon** | Valley between cushions, fabric banking on the curves | Banked turns, soft-edge off-track tuning |
| **Bathmat Rally** | Alternating high-grip rug and slick tile sections | Surface transitions as the core gimmick |
| **Desk Cable Run** | Tight weaving between monitor stands, mugs, and pen pots | Narrowest corridor; precision driving |
| **Laundry Basket Loop** | Ramp into an upturned basket with a banked wall-ride inside | Wall-riding; likely needs real physics support, most expensive here |

**Supporting work worth doing alongside:**
- **Per-surface grip tags** on track sections, which several ideas above lean on. Feeds directly into the surface-dependent tyre noise in 15.4.
- A **track-authoring workflow** (Section 12, P5 item 24). Both current tracks are procedural TypeScript deriving everything from one parametric centerline — that pattern scales well and is worth keeping for greybox layouts before committing to art.

### 15.3 More exciting UI

**Current state:** `overlay.ts` injects a flat CSS block and builds the lobby/results as plain DOM; the HUD is a single `hud.textContent` string assembled in `buildHud()`. Functional, deliberately minimal.

- **HUD** — replace the one-line text with real elements: a large lap counter, position as "2nd/6", a lap-delta split against your best, a segmented item slot, and a speed readout. Animate on change (place gain/loss flash, final-lap pulse).
- **Minimap** — already listed in Section 10 but not built. Cheap to do from the track's recovery spline as the outline, with cars as coloured dots reusing 15.1's palette.
- **Countdown** — big animated 3-2-1-GO with scale/fade, synced to the server's `countdownMs` rather than a local timer, so it can't drift from the authoritative start.
- **Lobby** — car colour swatches, per-player ready animation, a track preview thumbnail (top-down render of the spline) that updates when the track changes.
- **Results** — animate rows in by finishing order, highlight personal bests, show best-lap and total side by side, add a rematch countdown.
- **Race events** — transient toasts for overtakes, "final lap", recovery ("Nice save!"), and item pickups.
- **Motion polish** — speed-scaled camera FOV/shake, subtle vignette and chromatic shift while boosting, screen-edge blur at high speed.

Keep it DOM/CSS. Section 2 allows a light React layer, but the overlay is small enough that adding a framework now would cost more than it saves; revisit only if the HUD's state handling gets unwieldy.

### 15.4 Better noises

**Current state:** `audio.ts` is fully procedural Web Audio — one sawtooth oscillator for the engine drone with speed-mapped frequency, plus three `blip()` one-shots (boost, pickup, go). No asset files, no dependencies. Its docblock already anticipates swapping in sampled sfx.

- **Engine** — replace the single oscillator with a **layered** model: two or three detuned oscillators plus a filtered noise layer, a low-pass whose cutoff tracks throttle, and load-dependent timbre so accelerating sounds different from coasting at the same speed. Add a rev-limiter wobble near top speed.
- **Surface-dependent tyre noise** — filtered noise whose level tracks lateral slip, re-voiced per surface (rug, wood, cushion). Falls out naturally once tracks carry surface tags.
- **Impacts** — collision thumps scaled by impact velocity, distinct for car-vs-car and car-vs-scenery.
- **Recovery** — a proper sequence: the off-track "uh-oh", a claw whirr, and the re-drop thud, timed to the recovery animation.
- **Spatialisation** — route remote cars through `PannerNode`s positioned from their interpolated transforms, so you hear a rival coming up the inside. This is the single biggest perceptual upgrade and works with the procedural engine as-is.
- **Mix discipline** — a master bus with per-category gain (engine / sfx / music), ducking of the engine layer under important one-shots, and a persisted mute/volume control.
- **Sampled sfx** — bring in **howler.js** (already in the Section 2 stack) for recorded impacts and UI sounds, keeping the procedural engine for its continuous speed response. Call sites shouldn't need to change.

### 15.5 Banging soundtrack

- **Per-phase tracks** — distinct lobby, race, and results music, crossfaded on phase change (the client already has authoritative phase transitions via `setPhase`, so there's a clean hook).
- **Dynamic intensity** — layered stems (drums / bass / lead / pads) mixed by race state: add layers on the final lap, when you're in a podium position, or during a boost. Much more effective than switching songs, and avoids abrupt cuts.
- **Musical stingers** — short cues on race start, overtake, final lap, and finish, pitched to the current track's key so they land musically rather than clashing.
- **Beat-synced UI** — if the tempo is known, pulse countdown and menu animations on the beat. Cheap to do, disproportionately satisfying.
- **Practicalities** — stream compressed audio (Opus/AAC) from CloudFront, preload the lobby track during matchmaking so the drop isn't late, respect the browser's gesture requirement via the existing `audio.resume()` on ready-up, and keep music on its own gain bus so it can be muted independently. Licensing matters: use original or properly licensed music, since anything streamed to players is a distribution.

### 15.6 More power-ups

**Current state:** exactly one item exists. `ItemType` is the single-member union `'boost'`; `updateItems()` in `physics.ts` hardcodes `car.heldItem = 'boost'` on pad collection and `boostTimer = BOOST_SECONDS` on use. Pads live in `track.pickups` with cooldowns in `world.pickupCooldownUntil` keyed by pad index and compared against `world.tick`. Snapshots carry `heldItem` plus a `boosting` boolean.

Two structural gaps have to be closed before most of the interesting items are possible. Both are worth doing once, properly.

**(a) Randomised item rolls vs. determinism.** `stepWorld` is documented as deterministic — "no RNG, no wall-clock" — because the client replays it for prediction and reconciliation. Item selection needs randomness (and ideally position-weighted, Mario Kart style: last place gets better items). Options:
- **Seeded PRNG in world state** — store a seed/counter in `SimWorld`, advance it on each roll. Stays deterministic and client-predictable, but the client can then *see* what it's about to get, and a modified client could fish for good rolls.
- **Server-only roll** (recommended) — the server decides the item and the client learns it from the next snapshot. Prediction simply doesn't guess the item; it predicts driving and lets `heldItem` arrive authoritatively. A ~50–100 ms delay before the item icon appears is imperceptible, and it keeps rolls uncheatable. Note `stepSingleCar` already builds a one-entry world with an **empty** `pickupCooldownUntil`, so pad collection is approximate under prediction today — this direction is consistent with that.

**(b) World entities for projectiles and hazards.** `SimWorld` holds only `cars` and pad cooldowns, and `Snapshot` only `cars` and `pickups`. Anything that exists independently of a car (a shell in flight, a dropped mine, an oil slick) needs a new entity list in the world, a matching snapshot field, and interpolation on the client. Also needed: a **per-car effect state** richer than today's single `boostTimer`, since `carStateToSimCar` currently reconstructs boost from a boolean and would mis-handle several concurrent timed effects. A small `effects: { type, secondsRemaining }[]` is enough.

**Item ideas:**

| Item | Effect | Notes / cost |
|------|--------|--------------|
| **Boost** | *(exists)* Temporary top-speed + accel multiplier | Baseline |
| **Oil Slick** | Drop a puddle behind you; cars driving over it lose steering grip briefly | First world entity; static, no movement — cheapest of the new items |
| **Marble** | Roll a marble forward in a straight line; spins out the first car hit | First projectile: needs entity movement + collision vs cars |
| **Sticky Tape** | Drop a patch that hard-slows anyone crossing it | Reuses the Oil Slick entity, different effect |
| **Feather** | Brief one-shot hop over a hazard or a car | Needs real Y motion in the sim; currently `integrate()` only moves XZ |
| **Magnet** | Pulls you toward the car ahead for a second or two | No new entity, but needs "car ahead" resolution from checkpoint progress |
| **Static Shock** | Short control-scramble on all cars within a small radius | Radius query only, no entity; reuses the lockout mechanic |
| **Mini Mode** | Shrink briefly: faster and harder to hit, but shoved easily in collisions | Touches `CAR_COLLISION_RADIUS` per car, currently a global constant |
| **Dust Cloud** | Obscures the screen of cars behind you | Purely client-side VFX driven by an authoritative effect flag — cheap and very satisfying |
| **Homing Bee** | Slow projectile that tracks the car in the position ahead of you | Most expensive: projectile + targeting + prediction; do last |

**Balance and fairness:**
- **Position weighting** — roll from a weighted table keyed off live race position so trailing players get catch-up items and the leader mostly gets Boost. This is what makes items feel fair rather than random.
- **Reuse the existing lockout** — `RECOVERY_LOCKOUT_SECONDS` already implements "controls ignored, then handed back", and recovery grants brief invulnerability. Spin-outs and stuns should reuse that path rather than inventing a parallel mechanic, and item hits should respect the post-recovery invulnerability window so a car can't be re-hit the instant it lands.
- **Never cost lap progress** — consistent with the existing recovery rule in Section 1. Items cost time, never a lap.
- **One item slot** — keep the current single-`heldItem` model. It's readable at a glance in the HUD and sidesteps inventory UI entirely.
- **All effects server-authoritative**, per Section 9. The client renders effects and predicts driving; it never decides that a hit landed.

**Tuning constants** go in `constants.ts` alongside `BOOST_MULTIPLIER` / `BOOST_SECONDS`, since that file is explicitly part of the netcode contract and must stay identical on both sides.

### 15.7 Real graphics instead of solid colours

Replace the greybox with actual art: modelled toy cars, a textured living-room scene, and lighting that sells the "tiny cars on a real floor" fantasy. This is the single biggest change in perceived quality, and the one most likely to reveal performance limits.

**Current state:** everything is untextured primitives with flat `MeshStandardMaterial` colours.
- Cars are a shared `BoxGeometry(1, 0.5, 2)`, coloured blue if local and orange-red otherwise.
- The track is a procedurally generated ribbon (built in `buildTrack()` from the recovery spline, `trackHalfWidth` to each side) in flat dark grey.
- The "living room" is a single 80×60 green `PlaneGeometry`.
- Pickups are gold octahedra; the finish line is a white plane.
- Lighting is one ambient plus one directional light, with **no shadows enabled at all** — no `shadowMap`, no `castShadow`/`receiveShadow`.
- There is no asset loader, no texture, and no GLTF anywhere in the client.

Section 10 already commits to the target stack (GLTF + Draco, instanced props, baked lighting, texture atlases, served from S3/CloudFront). This entry is the sequenced version of that work.

**Asset pipeline (do this first — everything else depends on it).** There's no loader today, and `main()` is fully synchronous: it constructs the renderer, calls `buildTrack()`, and starts the frame loop immediately. Loading real assets means:
1. Add `GLTFLoader` + `DRACOLoader` (the Draco decoder needs serving alongside the bundle).
2. Introduce an **async asset-load phase** with a loading screen before the first frame. The lobby is a natural place to hide this — load during matchmaking and ready-up so it's invisible.
3. Keep a **greybox fallback**. If an asset fails to load, fall back to the current primitive so a missing file never yields a blank screen. This also keeps local dev fast when assets aren't present.

**Cars.**
- Low-poly GLTF body with PBR maps (albedo / normal / roughness). `MeshStandardMaterial` is already PBR, so this is incremental — no shader work.
- **Separate wheels** from the body so they can spin (scaled from `car.speed`) and steer visibly on the front axle.
- **Dependency on 15.1:** once cars are textured models, per-car colour can't just be `material.color` on the whole mesh. Author the body with a dedicated tintable material slot (or a colour-mask channel) so the palette index tints only the paintwork, leaving tyres, glass, and decals untouched. Worth deciding *before* modelling, since it's a mesh-authoring constraint, not a code one.
- Clone the loaded model per car, but **share geometry and textures** across clones — mirroring how `carGeometry` is shared today. Note `removeCar()` currently disposes only the material because geometry is shared; that invariant needs revisiting when each car owns a cloned material for tinting.
- Toy-appropriate detail: chunky plastic bevels, visible seam lines, a slightly worn finish. It should read as a *toy*, not a scale model.

**Track surface.** Keep generating the ribbon procedurally — it's the same geometry the physics uses, which is exactly why the drivable corridor is currently legible. Upgrade it in place rather than replacing it with an authored mesh:
- Generate proper **UVs** along the ribbon (V across the width, U along the arc length) so a tiling road/rug texture follows the curve without stretching.
- Add edge detailing: curbs, worn tape edges, or carpet fringing where the corridor ends, so the off-track boundary stays obvious once the flat grey is gone. **Don't lose this legibility** — players currently rely on the colour change to see where recovery triggers.
- Textured start/finish line and checkpoint markers instead of white planes.

**Scenery.** Replace the green plane with a real room: floorboards or carpet with a normal map, plus instanced props (books, pencils, mugs, cereal boxes, cushions) as the scenery Section 1 describes. Use `InstancedMesh` for repeated props. Cars stay individual meshes — at 8 players that's trivial.

**Lighting and shadows.** The biggest cheap win, because nothing currently grounds the cars to the floor:
- Enable `shadowMap` with `castShadow` on cars and props, `receiveShadow` on the floor and track.
- A single directional light with a tight, well-fitted shadow camera (the play area is only ~38×22 m, so shadow resolution can be generous).
- **Contact shadows** matter more than accurate ones at this scale — a small blob shadow directly under each car does most of the work of making it feel like a physical object on a floor.
- Bake static scenery lighting where possible (per Section 10) and keep only cars dynamic.
- Consider a warm lamp key plus cool window fill; it reads as "indoors" instantly.

**Effects.** Drift smoke and skid decals, boost exhaust and speed lines, sparks on collision, and a proper claw/hand model for the recovery animation (Section 10 lists this; it's still a placeholder dim-and-fade on the material today). All of these are driven by state the client already has.

**Performance.** This is where the Section 13 "browser perf on low-end machines" risk becomes real. Draco-compress meshes, atlas textures, cap particles, keep draw calls down via instancing, and set a frame budget target early. Test on integrated graphics, not just a dev machine — and profile *after* enabling shadows, which is usually the first thing to blow the budget.

**Camera.** Worth revisiting alongside the art. The camera is currently fixed at `(0, 46, 18)` looking at the origin, framed specifically for the oval's ~38×22 m extent. That framing won't survive the new tracks in 15.2, so either derive the camera from track bounds or move to the follow cam mentioned in Section 10.

### 15.8 Suggested ordering

Roughly by value-per-effort, and sequenced so nothing blocks on unfinished structural work:

1. **Car colours** (15.1) — small, server-side, and everything else builds on the palette (minimap dots, lobby swatches, results rows).
2. **UI pass** (15.3) — highest visible impact per hour; no engine changes needed.
3. **Audio spatialisation + engine layering** (15.4) — big perceptual gain, self-contained in `audio.ts`.
4. **Soundtrack** (15.5) — once the audio bus/mix structure from 15.4 exists.
5. **More tracks** (15.2) — more of the existing procedural-centerline pattern, no schema change.
6. **Power-up groundwork** (15.6) — server-side item rolls with position weighting, plus the per-car `effects` list. Ship a second item that needs no new entity (Static Shock or Dust Cloud) to prove the plumbing.
7. **World entities, then the rest of the items** (15.6) — add the entity list and snapshot field once, then Oil Slick → Sticky Tape → Marble. Leave Homing Bee and Feather last; they need targeting and Y motion respectively.
8. **Real graphics** (15.7) — biggest quality jump but the largest and most asset-dependent item, and it needs art that doesn't exist yet. Two exceptions worth pulling forward early, since both are code-only and improve the greybox immediately: **enabling shadows** (especially contact shadows under cars) and **camera framing derived from track bounds**, which 15.2 needs anyway. Settle the tintable-material decision with 15.1 before any car modelling starts.
