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

ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

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

EXPOSE 8001

CMD ["pnpm", "--filter", "@llm-council-search/api", "start"]

FROM node:22-bookworm-slim AS web

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY --from=base /app/node_modules ./node_modules
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts

EXPOSE 3000

CMD ["pnpm", "--filter", "@llm-council-search/web", "exec", "next", "start", "--hostname", "0.0.0.0", "-p", "3000"]

FROM node:22-bookworm-slim AS app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8001
ENV DATA_DIR=/app/data
ENV ALLOWED_ORIGINS=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=
ENV API_PROXY_TARGET=http://127.0.0.1:8001

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY --from=base /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts
COPY docker/start.sh ./docker/start.sh

RUN chmod +x ./docker/start.sh && mkdir -p /app/data

EXPOSE 3000

CMD ["./docker/start.sh"]
