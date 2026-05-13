# =============================================================
# Sylphie Drive Server - Railway Dockerfile
# Standalone WebSocket process that owns the 12-drive tick loop.
# Sylphie's main NestJS backend connects to it as a WS client.
#
# Build context: monorepo root (must be built from /app, not from
# apps/drive-server, because workspace packages live in sibling dirs).
# =============================================================

# ------ Stage 1: Install dependencies for the full workspace ------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json yarn.lock ./

COPY apps/sylphie/package.json          ./apps/sylphie/
COPY apps/drive-server/package.json     ./apps/drive-server/
COPY packages/shared/package.json       ./packages/shared/
COPY packages/decision-making/package.json ./packages/decision-making/
COPY packages/drive-engine/package.json ./packages/drive-engine/
COPY packages/learning/package.json     ./packages/learning/
COPY packages/planning/package.json     ./packages/planning/
COPY packages/supervisor/package.json   ./packages/supervisor/
COPY frontend/package.json              ./frontend/

RUN yarn install --frozen-lockfile

# ------ Stage 2: Build shared + drive-engine + drive-server ------
FROM deps AS build
WORKDIR /app

COPY . .

RUN yarn install --frozen-lockfile

# Drive-server transitively pulls @sylphie/shared and @sylphie/drive-engine.
RUN yarn workspace @sylphie/shared build
RUN cd packages/shared && npx prisma generate
RUN yarn workspace @sylphie/drive-engine build
RUN yarn workspace @sylphie/drive-server build

# ------ Stage 3: Production image ------
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

COPY package.json yarn.lock ./

COPY --from=build /app/apps/drive-server/package.json     ./apps/drive-server/
COPY --from=build /app/packages/shared/package.json       ./packages/shared/
COPY --from=build /app/packages/drive-engine/package.json ./packages/drive-engine/

RUN yarn install --production --frozen-lockfile

# Prisma client is required by @sylphie/shared transitively at runtime.
COPY --from=build /app/packages/shared/prisma         ./packages/shared/prisma
COPY --from=build /app/node_modules/.prisma           ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client    ./node_modules/@prisma/client

COPY --from=build /app/packages/shared/dist           ./packages/shared/dist
COPY --from=build /app/packages/drive-engine/dist     ./packages/drive-engine/dist
COPY --from=build /app/apps/drive-server/dist         ./apps/drive-server/dist

# Drive-server reaches into @sylphie/drive-engine/drive-process/* and
# /ipc-channel/* subpaths directly. The package has no `exports` field,
# so Node resolves those subpaths relative to the package root, not dist.
# Mirror the compiled dist contents to the package root so the lookups land.
RUN cp -r /app/packages/drive-engine/dist/. /app/packages/drive-engine/ \
 && cp -r /app/packages/shared/dist/.       /app/packages/shared/

EXPOSE 3001

# Drive server reads DRIVE_ENGINE_PORT / DRIVE_ENGINE_HOST.
# On Railway, bind to 0.0.0.0 so other services can reach it via private networking.
ENV DRIVE_ENGINE_HOST=0.0.0.0
ENV DRIVE_ENGINE_PORT=3001

CMD ["node", "apps/drive-server/dist/main.js"]
