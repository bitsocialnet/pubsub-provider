# Bitsocial Pubsub Provider

Run a Bitsocial pubsub fallback provider with a bundled Kubo node.

Modern Bitsocial apps such as 5chan use pure p2p in the browser by default. This provider is still useful as an optional fallback for clients that disable browser p2p, need a non-p2p pubsub relay, or want a public gateway/provider bundle for compatibility.

## What It Runs

- a public HTTP proxy for pubsub, gateway, name-provider, and delegated routing routes
- a bundled Kubo node with pubsub enabled
- a delegated HTTP routing provider at `/routing/v1/providers`
- optional ENS/SNS proxy helpers when chain RPC environment variables are configured

It includes the delegated HTTP routing compatibility endpoint that old provider clients used for provider lookup/provide requests. You can still run a dedicated tracker separately if you want that role split out.

## Ports

The defaults are chosen so this can run next to `bitsocial-seeder` on the same host.

| Purpose | Default | Notes |
| --- | ---: | --- |
| Public HTTP proxy | `8000` in the app, `80` in Docker Compose | Set `PUBSUB_PROVIDER_HTTP_PORT` for the host port in Compose. |
| Kubo swarm | `4002` TCP/UDP | Avoids the seeder's default Kubo swarm port `4001`. |
| Kubo API | `5001` local only | Used internally by the proxy. |
| Kubo gateway | `8080` local only | Used internally by the proxy. |

## Quick Start

```sh
git clone https://github.com/bitsocialnet/pubsub-provider.git
cd pubsub-provider
docker compose up -d
```

Check logs:

```sh
docker logs --follow pubsub-provider
```

Test the proxy:

```sh
curl http://127.0.0.1/commit-hash
```

## Configuration

Useful environment overrides:

```sh
PUBSUB_PROVIDER_HTTP_PORT=80
PUBSUB_PROVIDER_SWARM_PORT=4002
PUBSUB_PROVIDER_PORTS=8000
KUBO_RPC_URL=http://127.0.0.1:5001/api/v0
IPFS_GATEWAY_URL=http://127.0.0.1:8080
HTTP_ROUTER_URLS=https://example-router.invalid
PUBSUB_PROVIDER_ROUTING_STORE_PATH=
BASIC_AUTH_USERNAME=
BASIC_AUTH_PASSWORD=
IPFS_GATEWAY_USE_SUBDOMAINS=false
SHUTDOWN_KEY=
ETH_PROVIDER_URL=
ETH_PROVIDER_URL_WS=
SOL_PROVIDER_URL=
```

If you also run `bitsocial-seeder`, keep this provider on swarm port `4002` or another non-`4001` port.

## Local Development

Requires Node.js 24 or newer.

```sh
npm install
npm start -- [--ipfs-gateway-use-subdomains] [--shutdown-key <secret-key>]
```

Run tests:

```sh
npm test
```

## Cloudflare Note

Pubsub subscriptions use long-lived HTTP connections. Cloudflare can time out those keepalive connections unless response buffering/streaming behavior is configured appropriately. If pubsub fallback is the reason you run this provider, prefer direct DNS or infrastructure that supports long-lived streaming responses.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
