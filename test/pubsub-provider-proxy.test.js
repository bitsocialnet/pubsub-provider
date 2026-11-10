const http = require('http')
const {expect} = require('chai')

// config reads env at require time, so load the module after the mock kubo rpc is listening
const requireWithEnv = (env, modulePath) => {
  const previousEnv = {}
  for (const name in env) {
    previousEnv[name] = process.env[name]
    process.env[name] = env[name]
  }
  try {
    delete require.cache[require.resolve('../src/config')]
    delete require.cache[require.resolve(modulePath)]
    return require(modulePath)
  }
  finally {
    for (const name in previousEnv) {
      if (previousEnv[name] === undefined) {
        delete process.env[name]
      }
      else {
        process.env[name] = previousEnv[name]
      }
    }
  }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections()
  server.close(() => resolve())
})
const waitFor = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve))

describe('pubsub provider proxy', () => {
  let kubo, proxy, onKuboRequest

  before(async () => {
    kubo = http.createServer((req, res) => onKuboRequest(req, res))
    await listen(kubo)
    const {proxyPubsubProvider} = requireWithEnv({KUBO_RPC_URL: `http://127.0.0.1:${kubo.address().port}/api/v0`}, '../src/pubsub-provider')
    proxy = http.createServer((req, res) => proxyPubsubProvider(req, res))
    await listen(proxy)
  })

  after(async () => {
    await close(proxy)
    await close(kubo)
  })

  // open a subscription through the proxy and resolve once the first message arrives
  const subscribe = () => new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      hostname: '127.0.0.1',
      port: proxy.address().port,
      path: '/api/v0/pubsub/sub?arg=test-topic'
    }, (res) => {
      res.on('error', () => {})
      res.once('data', () => resolve({req, res}))
    })
    req.on('error', reject)
    req.end()
  })

  // kubo sends the stream headers and a first message, then keeps the stream open
  const holdSubscription = () => new Promise((resolve) => {
    onKuboRequest = (req, res) => {
      res.writeHead(200, {'content-type': 'application/json', 'x-chunked-output': '1'})
      res.write('{"data":"first"}\n')
      resolve({req, res})
    }
  })

  it('proxies a complete kubo response', async () => {
    onKuboRequest = (req, res) => {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end('{"ok":true}')
    }
    const res = await new Promise((resolve, reject) => {
      const req = http.request({method: 'POST', hostname: '127.0.0.1', port: proxy.address().port, path: '/api/v0/pubsub/pub?arg=test-topic'}, resolve)
      req.on('error', reject)
      req.end()
    })
    let body = ''
    res.on('data', (chunk) => {body += chunk})
    await waitFor(res, 'end')
    expect(res.statusCode).to.equal(200)
    expect(res.headers['access-control-allow-origin']).to.equal('*')
    expect(body).to.equal('{"ok":true}')
  })

  it('resets the client stream when kubo closes a subscription mid-stream', async () => {
    const kuboStream = holdSubscription()
    const client = await subscribe()
    const {res: kuboRes} = await kuboStream

    // kubo dies: the chunked response never completes
    const clientClosed = waitFor(client.res, 'close')
    kuboRes.socket.destroy()
    await clientClosed
    expect(client.res.complete).to.equal(false)
  })

  it('resets the client stream when kubo resets a subscription connection mid-stream', async () => {
    const kuboStream = holdSubscription()
    const client = await subscribe()
    const {res: kuboRes} = await kuboStream

    const clientClosed = waitFor(client.res, 'close')
    kuboRes.socket.resetAndDestroy()
    await clientClosed
    expect(client.res.complete).to.equal(false)
  })

  it('closes the kubo subscription when the client disconnects', async () => {
    const kuboStream = holdSubscription()
    const client = await subscribe()
    const {res: kuboRes} = await kuboStream

    const kuboClosed = waitFor(kuboRes, 'close')
    client.req.destroy()
    await kuboClosed
    expect(kuboRes.writableFinished).to.equal(false)
  })

  it('closes the kubo request when the client disconnects before kubo responds', async () => {
    const kuboRequest = new Promise((resolve) => {
      onKuboRequest = (req, res) => resolve({req, res})
    })
    const req = http.request({method: 'POST', hostname: '127.0.0.1', port: proxy.address().port, path: '/api/v0/pubsub/sub?arg=test-topic'})
    req.on('error', () => {})
    req.end()
    const {res: kuboRes} = await kuboRequest

    const kuboClosed = waitFor(kuboRes, 'close')
    req.destroy()
    await kuboClosed
  })
})
