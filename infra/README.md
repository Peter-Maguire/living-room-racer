# Infrastructure (CloudFormation)

All AWS resources are defined as CloudFormation templates here. Local deploys and
CI run the **same** templates with different `params/<env>.json` files. See
[`../plan.md`](../plan.md) Section 14 for the full design rationale.

## Layout

```
templates/
  root.yaml            # parent stack; nests the tier stacks below
  data.yaml            # DynamoDB tables (Retain)
  identity.yaml        # Cognito user/identity pools (Retain)
  api.yaml             # SAM: API Gateway + Lambda (auth, matchmaking, profiles)
  matchmaking.yaml     # GameLift FlexMatch rule set + config
  gamelift.yaml        # GameLift build ref, fleet, alias, queue
  web.yaml             # S3 + CloudFront for the client
  observability.yaml   # CloudWatch log group + dashboard
params/
  dev.json staging.json prod.json
scripts/
  # PowerShell (Windows dev)          # bash (Linux / CI) - equivalent
  bootstrap.ps1                       bootstrap.sh   # from-scratch: bucket -> build -> deploy -> publish
  deploy.ps1                          deploy.sh      # package + deploy one env (SAME templates as CI)
  outputs.ps1                         outputs.sh     # write stack outputs into client/server .env files
  publish-client.ps1                  publish-client.sh  # build client, s3 sync, CloudFront invalidation
  teardown.ps1                        teardown.sh    # delete an env (retained data survives by policy)
  lib.ps1                             lib.sh         # shared helpers
```

The `.ps1` and `.sh` scripts are behavior-equivalent. Use PowerShell on Windows;
the bash versions exist for Linux and GitHub Actions CI.

## Prerequisites

- AWS CLI v2, configured (`aws configure`) with credentials and a default region
- AWS SAM CLI (for Lambda packaging / `sam local`)
- pnpm + Node 20 (the scripts build the server/client)

## From scratch (new account or region)

```powershell
# PowerShell (Windows)
infra\scripts\bootstrap.ps1 -EnvName dev
```

```bash
# bash (Linux / CI)
infra/scripts/bootstrap.sh dev
```

This creates the artifact bucket, uploads the game-server build, deploys every
stack, writes outputs into the package `.env` files, and publishes the client.

## The local iteration loop

Deploy only the tier you changed — you rarely redeploy everything.

- **Lambda / API logic:** `sam local invoke` to test, then `deploy.ps1 -EnvName dev`.
- **Game server (physics, netcode):** iterate locally first with **GameLift Anywhere**;
  only `aws gamelift upload-build` + `deploy.ps1 -EnvName dev -BuildId <id>` when you need a hosted build.
- **Client:** `pnpm dev:client` locally; `publish-client.ps1 -EnvName dev` to publish. No stack update.
- **Infra (a table, an alarm, a rule):** edit the one template, then preview with a change set first:

  ```powershell
  infra\scripts\deploy.ps1 -EnvName dev -ChangeSet   # review adds/replaces/DELETES
  infra\scripts\deploy.ps1 -EnvName dev              # apply once it looks right
  ```

Always use `-ChangeSet` before applying changes that touch `data.yaml` or
`identity.yaml` so a surprise delete of a table or user pool never executes silently.

## Safety rails

- DynamoDB tables, Cognito pools, and the web/artifact buckets use
  `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain`.
- `teardown.ps1` / `teardown.sh` delete only the stacks; retained data survives
  and must be removed explicitly (`-PurgeRetained` / `--purge-retained` leaves it manual).
- Prefer change sets for stateful updates.

## Clean-room test

Prove from-scratch still works:

```powershell
infra\scripts\teardown.ps1 -EnvName dev
infra\scripts\bootstrap.ps1 -EnvName dev
```
