const config = require('./config')
const fs = require('fs-extra')
const path = require('path')
const net = require('net')
const ipaddr = require('ipaddr.js')
const Debug = require('debug')
const promClient = require('prom-client')

const debug = Debug(`${config.debugNamespace}:http-routing-provider`)

const routePrefix = '/routing/v1/providers'
const bodyLimitBytes = 1024 * 1024
const ttl = 1000 * 60 * 60 * 24
const dagPbCodec = 0x70
const cidV1 = 1

let cidModulePromise
let multiaddrModulePromise
let store
let writeQueue = Promise.resolve()

const labels = {}
const counters = {
  getProvidersRequestCount: new promClient.Counter({
    name: 'bitsocial_pubsub_provider_routing_get_providers_request_count',
    help: 'count of http routing provider get providers requests',
    registers: [promClient.register]
  }),
  getProvidersRequestSuccessCount: new promClient.Counter({
    name: 'bitsocial_pubsub_provider_routing_get_providers_request_success_count',
    help: 'count of http routing provider successful get providers requests',
    registers: [promClient.register]
  }),
  getProvidersProviderCount: new promClient.Counter({
    name: 'bitsocial_pubsub_provider_routing_get_providers_provider_count',
    help: 'count of http routing provider records returned',
    registers: [promClient.register]
  }),
  putProvidersRequestCount: new promClient.Counter({
    name: 'bitsocial_pubsub_provider_routing_put_providers_request_count',
    help: 'count of http routing provider put providers requests',
    registers: [promClient.register]
  }),
  putProvidersRequestSuccessCount: new promClient.Counter({
    name: 'bitsocial_pubsub_provider_routing_put_providers_request_success_count',
    help: 'count of http routing provider successful put providers requests',
    registers: [promClient.register]
  }),
  putProvidersProviderCount: new promClient.Counter({
    name: 'bitsocial_pubsub_provider_routing_put_providers_provider_count',
    help: 'count of http routing provider records accepted',
    registers: [promClient.register]
  })
}

const loadCidModule = async () => {
  cidModulePromise ||= import('multiformats/cid')
  return cidModulePromise
}

const loadMultiaddrModule = async () => {
  multiaddrModulePromise ||= import('@multiformats/multiaddr')
  return multiaddrModulePromise
}

const createEmptyStore = () => ({
  version: 1,
  cids: {}
})

const loadStore = async () => {
  if (store) {
    return store
  }

  try {
    store = await fs.readJson(config.routingProviderStorePath)
    if (!store || store.version !== 1 || !store.cids || typeof store.cids !== 'object') {
      store = createEmptyStore()
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`failed reading routing provider store at ${config.routingProviderStorePath}`, e)
    }
    store = createEmptyStore()
  }

  return store
}

const saveStore = async () => {
  await loadStore()
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await fs.ensureDir(path.dirname(config.routingProviderStorePath))
    const tmpPath = `${config.routingProviderStorePath}.${process.pid}.tmp`
    await fs.writeJson(tmpPath, store)
    await fs.rename(tmpPath, config.routingProviderStorePath)
  })
  return writeQueue
}

const randomizeArray = (array) => {
  let currentIndex = array.length
  while (currentIndex !== 0) {
    const randomIndex = Math.floor(Math.random() * currentIndex)
    currentIndex--
    ;[array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]]
  }
  return array
}

const removeDuplicates = (array) => [...new Set(array)]

const normalizeCid = async (cidString) => {
  const {CID} = await loadCidModule()
  const cid = CID.parse(cidString)
  if (cid.code === dagPbCodec) {
    return cid.toV1().toString()
  }
  return CID.create(cidV1, dagPbCodec, cid.multihash).toString()
}

const getRequestIp = (req) => {
  const forwardedFor = req.headers['x-forwarded-for']
  const firstForwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(',')[0]
  const ip = (firstForwardedIp || req.socket.remoteAddress || req.connection.remoteAddress || '').trim()
  return ip.startsWith('::ffff:') ? ip.replace('::ffff:', '') : ip
}

const parseIp = (ip) => {
  try {
    return ipaddr.parse(ip)
  } catch (e) {
    return undefined
  }
}

const isSameIp = (a, b) => {
  const parsedA = parseIp(a)
  const parsedB = parseIp(b)
  return Boolean(parsedA && parsedB && parsedA.kind() === parsedB.kind() && parsedA.toNormalizedString() === parsedB.toNormalizedString())
}

const isPublicIp = (ip) => {
  const parsed = parseIp(ip)
  return parsed?.range() === 'unicast'
}

const cleanAddrs = async (addrs, reqIp) => {
  if (!reqIp || typeof reqIp !== 'string') {
    throw Error(`cleanAddrs reqIp '${reqIp}' not a string`)
  }
  if (!Array.isArray(addrs)) {
    return []
  }

  const {multiaddr} = await loadMultiaddrModule()

  if (net.isIP(reqIp) === 4) {
    addrs = addrs.filter(addr => !addr.startsWith('/ip6/::')).map(addr => addr.replace('0.0.0.0', reqIp))
  } else if (net.isIP(reqIp) === 6) {
    addrs = addrs.filter(addr => !addr.startsWith('/ip4/0.0.0.0')).map(addr => addr.replace('::', reqIp))
  }

  if (process.env.NO_IP_VALIDATE) {
    return [...addrs]
  }

  const cleaned = []
  for (const addr of addrs) {
    multiaddr(addr)

    const addrIp = addr.match(/^\/ip(?:4|6)\/([^/]+)/)?.[1]
    if (!addrIp) {
      cleaned.push(addr)
      continue
    }

    if (!isSameIp(addrIp, reqIp)) {
      if (addr.includes('p2p-circuit')) {
        cleaned.push(addr)
      }
      continue
    }

    if (!isPublicIp(addrIp)) {
      continue
    }

    cleaned.push(addr)
  }
  return cleaned
}

const getProviders = async (cidString) => {
  const normalizedCid = await normalizeCid(cidString)
  const currentStore = await loadStore()
  const cidRecord = currentStore.cids[normalizedCid]
  const expiryDate = Date.now() - ttl

  if (!cidRecord?.providers) {
    return {providers: [], lastModified: undefined}
  }

  let providers = Object.values(cidRecord.providers)
  providers = providers.filter(provider => provider.lastModified > expiryDate)

  if (providers.length !== Object.keys(cidRecord.providers).length) {
    cidRecord.providers = Object.fromEntries(providers.map(provider => [provider.provider.ID, provider]))
    await saveStore()
  }

  providers = randomizeArray(providers)
  if (providers.length > 100) {
    providers.length = 100
  }

  return {
    providers: providers.map(provider => provider.provider),
    lastModified: cidRecord.lastModified
  }
}

const addProviders = async (providers) => {
  const currentStore = await loadStore()
  const cids = {}

  for (const provider of providers) {
    for (const key of removeDuplicates(provider.Payload.Keys || [])) {
      const cid = await normalizeCid(key)
      cids[cid] ||= []
      cids[cid].push(provider)
    }
  }

  const expiryDate = Date.now() - ttl
  const now = Date.now()

  for (const cid in cids) {
    const cidRecord = currentStore.cids[cid] || {providers: {}}
    for (const providerId in cidRecord.providers) {
      if (cidRecord.providers[providerId].lastModified < expiryDate) {
        delete cidRecord.providers[providerId]
      }
    }

    for (const newProvider of cids[cid]) {
      cidRecord.providers[newProvider.Payload.ID] = {
        provider: {
          Schema: 'peer',
          Addrs: newProvider.Payload.Addrs,
          ID: newProvider.Payload.ID,
          Protocols: [newProvider.Protocol]
        },
        lastModified: now
      }
    }

    cidRecord.lastModified = now
    currentStore.cids[cid] = cidRecord
  }

  await saveStore()
}

const readJsonBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0

  req.on('data', (chunk) => {
    size += chunk.length
    if (size > bodyLimitBytes) {
      reject(Object.assign(Error('request body too large'), {statusCode: 413}))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8') || '{}'
      resolve(JSON.parse(body))
    } catch (e) {
      reject(Object.assign(Error('invalid json body'), {statusCode: 400}))
    }
  })
  req.on('error', reject)
})

const setCorsHeaders = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
  if (req.headers['access-control-request-headers']) {
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'])
  } else {
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
  }
}

const sendJson = (res, statusCode, body, extraHeaders = {}) => {
  const resBody = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(resBody),
    ...extraHeaders
  })
  res.end(resBody)
}

const sendError = (res, statusCode, message) => {
  sendJson(res, statusCode, {error: message})
}

const handlePutProviders = async (req, res) => {
  counters.putProvidersRequestCount.inc(labels, 1)
  const body = await readJsonBody(req)
  if (!Array.isArray(body.Providers)) {
    sendError(res, 400, 'Providers must be an array')
    return
  }

  const reqIp = getRequestIp(req)
  const providers = []

  for (const provider of body.Providers) {
    if (!provider?.Payload?.ID || !Array.isArray(provider.Payload.Keys)) {
      continue
    }
    provider.Payload.Addrs = await cleanAddrs(provider.Payload.Addrs, reqIp)
    if (provider.Payload.Addrs.length) {
      providers.push(provider)
    }
  }

  counters.putProvidersProviderCount.inc(labels, providers.length)
  if (!providers.length) {
    debug('no providers with valid addresses')
  }

  await addProviders(providers)

  sendJson(res, 200, {
    ProvideResults: body.Providers.map(Provider => ({
      Schema: Provider.Schema,
      Protocol: Provider.Protocol,
      AdvisoryTTL: Provider.Payload?.AdvisoryTTL
    }))
  })
  counters.putProvidersRequestSuccessCount.inc(labels, 1)
}

const handleGetProviders = async (req, res, cid) => {
  counters.getProvidersRequestCount.inc(labels, 1)
  const {providers, lastModified} = await getProviders(cid)
  counters.getProvidersProviderCount.inc(labels, providers.length)

  const headers = {
    Vary: 'Accept',
    'Cache-Control': `public, max-age=${providers.length ? 60 : 10}, public, stale-if-error=${60 * 60 * 24}`
  }
  if (lastModified) {
    headers['Last-Modified'] = new Date(lastModified).toUTCString()
  }

  sendJson(res, providers.length ? 200 : 404, {Providers: providers.length ? providers : null}, headers)
  counters.getProvidersRequestSuccessCount.inc(labels, 1)
}

const isHttpRoutingProvider = (req) => req.url.startsWith(routePrefix)

const handleHttpRoutingProvider = async (req, res) => {
  setCorsHeaders(req, res)

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === `${routePrefix}/metrics/prometheus`) {
      res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'})
      res.end(await promClient.register.metrics())
      return
    }

    if (url.pathname === routePrefix || url.pathname === `${routePrefix}/`) {
      if (req.method !== 'PUT') {
        sendError(res, 405, 'method not allowed')
        return
      }
      await handlePutProviders(req, res)
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith(`${routePrefix}/`)) {
      const cid = decodeURIComponent(url.pathname.slice(routePrefix.length + 1))
      if (!cid || cid.includes('/')) {
        sendError(res, 404, 'not found')
        return
      }
      await handleGetProviders(req, res, cid)
      return
    }

    sendError(res, 404, 'not found')
  } catch (e) {
    const statusCode = e.statusCode || 400
    debug('request failed', e)
    sendError(res, statusCode, e.message)
  }
}

module.exports = {
  isHttpRoutingProvider,
  handleHttpRoutingProvider,
  _private: {
    addProviders,
    cleanAddrs,
    getProviders,
    normalizeCid,
    resetStoreForTests: () => {
      store = createEmptyStore()
      writeQueue = Promise.resolve()
    }
  }
}
