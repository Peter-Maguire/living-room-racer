# Game server image for AWS GameLift container fleets.
# Built from the monorepo root so the shared package is available.
#   docker build -f packages/server/Dockerfile -t racer-server .
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile || pnpm install
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @racer/shared build && pnpm --filter @racer/server build
RUN pnpm --filter @racer/server --prod deploy /out

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV USE_GAMELIFT=true
COPY --from=build /out ./
EXPOSE 3001
CMD ["node", "dist/index.js"]
