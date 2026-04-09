# ============================================================
# Sylphie — Multi-stage Railway Dockerfile
# Builds: shared packages → NestJS backend → Vite frontend
# Serves: NestJS backend + static frontend on a single PORT
# ============================================================

# ------ Stage 1: Install all dependencies ------
FROM node:20-alpine AS deps
WORKDIR /app

# Copy workspace root
COPY package.json yarn.lock ./

# Copy every workspace package.json so yarn can resolve the workspace graph
COPY apps/sylphie/package.json          ./apps/sylphie/
COPY apps/drive-server/package.json     ./apps/drive-server/
COPY packages/shared/package.json       ./packages/shared/
COPY packages/decision-making/package.json ./packages/decision-making/
COPY packages/drive-engine/package.json ./packages/drive-engine/
COPY packages/learning/package.json     ./packages/learning/
COPY packages/planning/package.json     ./packages/planning/
COPY frontend/package.json              ./frontend/

RUN yarn install --frozen-lockfile

# ------ Stage 2: Build everything ------
FROM deps AS build
WORKDIR /app

# Copy full source (respects .dockerignore)
COPY . .

# Re-link workspace packages (source was copied over the deps layer)
RUN yarn install --frozen-lockfile

# 1. Build @sylphie/shared (all other packages depend on it)
RUN yarn workspace @sylphie/shared build

# 2. Generate Prisma client
RUN cd packages/shared && npx prisma generate

# 3. Build internal packages in dependency order
#    drive-engine depends on shared
#    decision-making depends on shared + drive-engine
#    learning, planning depend on shared + decision-making
RUN yarn workspace @sylphie/drive-engine build
RUN yarn workspace @sylphie/decision-making build
RUN yarn workspace @sylphie/learning build && \
    yarn workspace @sylphie/planning build

# 4. Build the NestJS backend
RUN yarn workspace @sylphie/app build

# 5. Build the Vite frontend
RUN cd frontend && npx vite build

# ------ Stage 3: Production image ------
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

# Copy workspace root manifests
COPY package.json yarn.lock ./

# Copy package.json files for workspace resolution
COPY --from=build /app/apps/sylphie/package.json          ./apps/sylphie/
COPY --from=build /app/apps/drive-server/package.json     ./apps/drive-server/
COPY --from=build /app/packages/shared/package.json       ./packages/shared/
COPY --from=build /app/packages/decision-making/package.json ./packages/decision-making/
COPY --from=build /app/packages/drive-engine/package.json ./packages/drive-engine/
COPY --from=build /app/packages/learning/package.json     ./packages/learning/
COPY --from=build /app/packages/planning/package.json     ./packages/planning/
COPY --from=build /app/frontend/package.json              ./frontend/

# Install production-only dependencies (preserves workspace symlinks)
RUN yarn install --production --frozen-lockfile

# Copy Prisma schema + generated client
COPY --from=build /app/packages/shared/prisma               ./packages/shared/prisma
COPY --from=build /app/node_modules/.prisma                  ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client           ./node_modules/@prisma/client

# Copy compiled output for each package
COPY --from=build /app/packages/shared/dist                  ./packages/shared/dist
COPY --from=build /app/packages/decision-making/dist         ./packages/decision-making/dist
COPY --from=build /app/packages/drive-engine/dist            ./packages/drive-engine/dist
COPY --from=build /app/packages/learning/dist                ./packages/learning/dist
COPY --from=build /app/packages/planning/dist                ./packages/planning/dist

# Copy NestJS backend compiled output
COPY --from=build /app/apps/sylphie/dist                     ./apps/sylphie/dist

# Copy Vite frontend build
COPY --from=build /app/frontend/dist                         ./frontend/dist

# Copy database init scripts (for reference / manual migrations)
COPY --from=build /app/infra                                 ./infra

EXPOSE 3000

# Railway sets PORT; the app reads process.env.PORT || process.env.APP_PORT || 3000
CMD ["node", "apps/sylphie/dist/main.js"]
