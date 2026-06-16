# Docker Guide

## Start

```sh
git clone https://github.com/bitsocialnet/pubsub-provider.git
cd pubsub-provider
docker compose pull
docker compose up -d
```

The published image already bundles Kubo. The default Compose file uses the pinned published image instead of rebuilding from local source.

Build locally only when you are developing the provider itself:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build -d
```

The Docker build downloads Kubo once and stores it in the image so container restarts do not depend on `dist.ipfs.*` DNS.

The Compose setup publishes:

- HTTP proxy: host `80` to container `8000`
- Kubo swarm: host/container `4002` TCP and UDP

Use a different host HTTP port:

```sh
PUBSUB_PROVIDER_HTTP_PORT=8088 docker compose up -d
```

Use a different Kubo swarm port:

```sh
PUBSUB_PROVIDER_SWARM_PORT=4012 docker compose up -d
```

Keep the swarm port different from any local `bitsocial-seeder` daemon, which normally uses Kubo swarm `4001`.

## Startup Download Issues

If you see `downloading ipfs...` or `getaddrinfo EAI_AGAIN dist.ipfs.io`, the container is almost certainly still running an old local image or an old checkout. Force a recreate from the pinned published image:

```sh
git pull
docker compose down
docker compose pull
docker compose up -d --force-recreate
```

Check what is actually running:

```sh
docker inspect pubsub-provider --format 'image={{.Image}} restarts={{.RestartCount}}'
docker exec pubsub-provider /app/bin/ipfs version
curl http://127.0.0.1/commit-hash
```

For source/local builds, the downloader retries `dist.ipfs.tech`, `dist.ipfs.io`, and GitHub release assets. You can override those mirrors:

```sh
PUBSUB_PROVIDER_KUBO_DOWNLOAD_URLS=https://dist.ipfs.tech/kubo,https://github.com/ipfs/kubo/releases/download docker compose up --build -d
```

## Logs

```sh
docker logs --follow pubsub-provider
```

## Stop

```sh
docker compose down
```

## Domain And TLS

Point your domain at the server and put a TLS reverse proxy in front of the HTTP proxy, or run the certbot helper scripts in `scripts/` after setting the required domain/email environment variables.

Pubsub fallback needs long-lived streaming responses. If you use Cloudflare or another CDN, make sure it does not buffer or time out pubsub subscription responses too aggressively.
