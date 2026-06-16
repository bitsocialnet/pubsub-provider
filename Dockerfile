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

FROM node:24-bookworm-slim AS kubo

ARG KUBO_VERSION=0.34.1
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar \
  && rm -rf /var/lib/apt/lists/* \
  && set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) kubo_arch=amd64 ;; \
      arm64) kubo_arch=arm64 ;; \
      arm|arm/v7) kubo_arch=arm ;; \
      386|i386) kubo_arch=386 ;; \
      *) echo "unsupported Kubo architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac; \
    kubo_file="kubo_v${KUBO_VERSION}_linux-${kubo_arch}.tar.gz"; \
    for kubo_base_url in \
      "https://dist.ipfs.tech/kubo" \
      "https://dist.ipfs.io/kubo" \
      "https://github.com/ipfs/kubo/releases/download"; do \
      kubo_url="${kubo_base_url}/v${KUBO_VERSION}/${kubo_file}"; \
      echo "Downloading ${kubo_url}"; \
      if curl -fsSL --retry 5 --retry-all-errors --connect-timeout 20 --max-time 600 "${kubo_url}" -o /tmp/kubo.tar.gz; then \
        break; \
      fi; \
    done; \
    test -s /tmp/kubo.tar.gz; \
    tar -xzf /tmp/kubo.tar.gz -C /tmp; \
    chmod 755 /tmp/kubo/ipfs

FROM node:24-bookworm-slim AS runtime

ARG VCS_REF=development

WORKDIR /app
ENV NODE_ENV=production \
  PUBSUB_PROVIDER_HOST=0.0.0.0 \
  PUBSUB_PROVIDER_PORTS=8000 \
  PUBSUB_PROVIDER_SWARM_PORT=4002 \
  KUBO_RPC_URL=http://127.0.0.1:5001/api/v0 \
  IPFS_GATEWAY_URL=http://127.0.0.1:8080 \
  IPFS_GATEWAY_USE_SUBDOMAINS=false \
  IPFS_PATH=/data/ipfs \
  PUBSUB_PROVIDER_COMMIT_HASH=${VCS_REF}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /app/bin \
  && chown -R node:node /data /app

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
COPY --chown=node:node --chmod=755 --from=kubo /tmp/kubo/ipfs ./bin/ipfs

VOLUME ["/data"]
USER node

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/start.js"]
