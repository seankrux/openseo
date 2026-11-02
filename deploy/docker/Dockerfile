# syntax=docker/dockerfile:1
# workerd requires glibc; Alpine is not a compatible runtime.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

# The slim image needs an explicit CA trust store for workerd's outbound HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.30.1 --activate

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_OPTIONS=--max-old-space-size=4096
LABEL org.opencontainers.image.source="https://github.com/seankrux/openseo"

# Vite, Wrangler and TypeScript are runtime requirements: this self-host path
# builds at startup so client-side auth/env settings match the supplied env.
COPY --from=dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --chown=1000:1000 . .
RUN mkdir -p /app/.wrangler && chown node:node /app /app/.wrangler
USER node

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health',{signal:AbortSignal.timeout(8000)}).then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

CMD ["sh", "deploy/docker/docker-entrypoint.sh"]
