FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

FROM base AS build

COPY . .

RUN pnpm --filter @llm-council-search/api build
RUN pnpm --filter @llm-council-search/web exec next build --webpack

FROM node:22-bookworm-slim AS api

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY --from=base /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist

RUN mkdir -p /app/data

EXPOSE 4001

CMD ["pnpm", "--filter", "@llm-council-search/api", "start"]

FROM node:22-bookworm-slim AS web

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=4000

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json

# Reinstall production dependencies in the runtime image so pnpm workspace
# packages resolve correctly after the build stage.
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts

EXPOSE 4000

CMD ["pnpm", "--filter", "@llm-council-search/web", "exec", "next", "start", "--hostname", "0.0.0.0", "-p", "4000"]

FROM node:22-bookworm-slim AS app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=4001
ENV DATA_DIR=/app/data
ENV ALLOWED_ORIGINS=http://localhost:4000
ENV API_PROXY_TARGET=http://127.0.0.1:4001

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

# Reinstall production dependencies in the runtime image so pnpm workspace
# packages resolve correctly after the build stage.
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts
COPY docker/start.sh ./docker/start.sh

RUN chmod +x ./docker/start.sh && mkdir -p /app/data

EXPOSE 4000
EXPOSE 4001

CMD ["./docker/start.sh"]
