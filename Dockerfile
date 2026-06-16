# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
  PUBSUB_PROVIDER_HOST=0.0.0.0 \
  PUBSUB_PROVIDER_PORTS=8000 \
  PUBSUB_PROVIDER_SWARM_PORT=4002 \
  KUBO_RPC_URL=http://127.0.0.1:5001/api/v0 \
  IPFS_GATEWAY_URL=http://127.0.0.1:8080 \
  IPFS_GATEWAY_USE_SUBDOMAINS=false \
  IPFS_PATH=/data/ipfs

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /app/bin \
  && chown -R node:node /data /app

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

VOLUME ["/data"]
USER node

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/start.js"]
