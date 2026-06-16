# Docker Guide

## Start

```sh
git clone https://github.com/bitsocialnet/pubsub-provider.git
cd pubsub-provider
docker compose up -d
```

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
