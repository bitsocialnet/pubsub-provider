const path = require('path')

const parsePort = (value, fallback, name) => {
  const port = Number(value || fallback)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Error(`${name} must be a TCP/UDP port between 1 and 65535`)
  }
  return port
}

const parsePortList = (value, fallback) => {
  const ports = String(value || fallback)
    .split(',')
    .map(port => parsePort(port.trim(), undefined, 'PUBSUB_PROVIDER_PORTS'))
  return [...new Set(ports)]
}

const ensureApiBaseUrl = (url) => {
  const normalized = url.toString().replace(/\/$/, '')
  return normalized.endsWith('/api/v0') ? normalized : `${normalized}/api/v0`
}

const toMultiaddrHost = (hostname) => {
  if (hostname === 'localhost') {
    return '127.0.0.1'
  }
  return hostname
}

const getUrlPort = (url) => Number(url.port || (url.protocol === 'https:' ? 443 : 80))

const ipfsApiUrl = new URL(process.env.KUBO_RPC_URL || 'http://127.0.0.1:5001/api/v0')
const ipfsGatewayUrl = new URL(process.env.IPFS_GATEWAY_URL || 'http://127.0.0.1:8080')
const ipfsDataPath = path.resolve(process.env.IPFS_PATH || process.env.PUBSUB_PROVIDER_DATA_PATH || path.join(__dirname, '..', '.ipfs'))

module.exports = {
  appName: 'pubsub-provider',
  debugNamespace: 'pubsub-provider',
  proxyHost: process.env.PUBSUB_PROVIDER_HOST || '0.0.0.0',
  proxyPorts: parsePortList(process.env.PUBSUB_PROVIDER_PORTS || process.env.PORT, '8000'),
  ipfsDataPath,
  routingProviderStorePath: path.resolve(process.env.PUBSUB_PROVIDER_ROUTING_STORE_PATH || path.join(ipfsDataPath, 'http-routing-providers.json')),
  ipfsApiUrl,
  ipfsApiBaseUrl: ensureApiBaseUrl(ipfsApiUrl),
  ipfsApiOrigin: `${ipfsApiUrl.protocol}//${ipfsApiUrl.host}`,
  ipfsApiMultiaddrHost: toMultiaddrHost(ipfsApiUrl.hostname),
  ipfsApiPort: getUrlPort(ipfsApiUrl),
  ipfsGatewayUrl,
  ipfsGatewayOrigin: `${ipfsGatewayUrl.protocol}//${ipfsGatewayUrl.host}`,
  ipfsGatewayMultiaddrHost: toMultiaddrHost(ipfsGatewayUrl.hostname),
  ipfsGatewayPort: getUrlPort(ipfsGatewayUrl),
  ipfsSwarmPort: parsePort(process.env.PUBSUB_PROVIDER_SWARM_PORT || process.env.IPFS_SWARM_PORT, 4002, 'PUBSUB_PROVIDER_SWARM_PORT')
}
