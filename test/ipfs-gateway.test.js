const http = require('http')
const httpProxy = require('http-proxy')
const {expect} = require('chai')

// config reads env at require time, so load the module after the mock kubo servers are listening
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

const bitsocialJson = JSON.stringify({content: 'hello', signature: {signature: 'abc', type: 'ed25519'}})
const fileCid = 'bafkreigur6gzxm3ykiol7ywou3iy3obruzs2q7boizj7oznznid34dzc3e'
const notBitsocialCid = 'bafkreicafdegmgvhbsc4z4whwcz3wjdoeu3jpcuy2mfckqtq5dikjelzau'
const dirCid = 'bafybeigvgzoolc3drupxhlevdp2ugqcrbcsqfmcek2zxiw5wctk3xjpjwy'
const slowCid = 'QmSf6sTLvGrCzpLcqdRLy8xUmLUhgdyAQi1VaFy7Aa2VHW'
// ipns name that resolves to a directory, `cat` on the directory root never answers,
// so a revalidation of the name (resolve + root cat) stays pending
const ipnsDirName = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8'
const ipnsDirCid = 'bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm'
// ipns name whose record points to a path inside a directory, the gateway serves <cid>/other/<sub path>
const ipnsPathName = 'k51qzi5uqu5dhtql7c3ac0fgwvqfqkpfwmvn5mhwxs4r1vgu0o9v1nsv1hmw4a'
const ipnsPathCid = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
// ipns name whose record is not an /ipfs/ path
const ipnsNotIpfsName = 'k51qzi5uqu5dgy7t4q2kq8xtlr6hmtm4kq7zn2dz5bhzb0xvmrt3gf9ia8yb1c'

// what kubo rpc `name/resolve` returns for each name
const ipnsRecords = {
  [ipnsDirName]: `/ipfs/${ipnsDirCid}`,
  [ipnsPathName]: `/ipfs/${ipnsPathCid}/other`,
  [ipnsNotIpfsName]: `/ipns/${dirCid}`
}

// what kubo rpc `cat` returns for each path
const kuboFiles = {
  [fileCid]: bitsocialJson,
  [notBitsocialCid]: '<html>not bitsocial</html>',
  [`${dirCid}/update`]: bitsocialJson,
  [`${dirCid}/index.html`]: '<html>website</html>',
  [`${ipnsDirCid}/update`]: bitsocialJson,
  [`${ipnsDirCid}/index.html`]: '<html>website</html>',
  [`${ipnsPathCid}/update`]: bitsocialJson,
  [`${ipnsPathCid}/other/update`]: '<html>website</html>',
  [`${ipnsPathCid}/other/post`]: bitsocialJson
}

describe('ipfs gateway', () => {
  let kuboApi, kuboGateway, server, ipfsGateway, catArgs, gatewayRequests

  before(async () => {
    kuboApi = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const arg = url.searchParams.get('arg')
      catArgs.push(arg)
      if (url.pathname === '/api/v0/name/resolve' && ipnsRecords[arg]) {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({Path: ipnsRecords[arg]}))
        return
      }
      if (url.pathname !== '/api/v0/cat' || arg === slowCid || arg === ipnsDirCid) {
        return // never answers
      }
      if (kuboFiles[arg]) {
        res.writeHead(200, {'content-type': 'text/plain'})
        res.end(kuboFiles[arg])
        return
      }
      res.writeHead(500, {'content-type': 'application/json'})
      res.end(JSON.stringify({Message: arg === dirCid ? 'this dag node is a directory' : `invalid path "${arg}"`, Code: 0, Type: 'error'}))
    })
    await listen(kuboApi)
    kuboGateway = http.createServer((req, res) => {
      gatewayRequests.push(`${req.headers.host} ${req.url}`)
      res.end('served by gateway')
    })
    await listen(kuboGateway)

    ipfsGateway = requireWithEnv({
      KUBO_RPC_URL: `http://127.0.0.1:${kuboApi.address().port}/api/v0`,
      IPFS_GATEWAY_URL: `http://127.0.0.1:${kuboGateway.address().port}`
    }, '../src/ipfs-gateway')
    const proxy = httpProxy.createProxyServer({})
    proxy.on('error', (e, req, res) => {
      res.statusCode = 502
      res.end(`502 Bad Gateway: ${e.message}`)
    })
    server = http.createServer((req, res) => ipfsGateway.proxyIpfsGateway(proxy, req, res))
    await listen(server)
  })

  beforeEach(() => {
    catArgs = []
    gatewayRequests = []
  })

  after(async () => {
    ipfsGateway._private.setFetchTimeoutForTests(180_000)
    await close(server)
    await close(kuboGateway)
    await close(kuboApi)
  })

  const get = (path, host = 'localhost') => new Promise((resolve, reject) => {
    const req = http.request({method: 'GET', hostname: '127.0.0.1', port: server.address().port, path, headers: {host}}, (res) => {
      let body = ''
      res.on('data', (chunk) => {body += chunk})
      res.on('end', () => resolve({status: res.statusCode, body}))
    })
    req.on('error', reject)
    req.end()
  })

  it('serves Bitsocial content', async () => {
    const res = await get(`/ipfs/${fileCid}`)
    expect(res).to.deep.equal({status: 200, body: 'served by gateway'})
    expect(catArgs).to.deep.equal([fileCid])
  })

  it('validates and serves a Bitsocial file inside a directory', async () => {
    const res = await get(`/ipfs/${dirCid}/update`)
    expect(res).to.deep.equal({status: 200, body: 'served by gateway'})
    expect(catArgs).to.deep.equal([`${dirCid}/update`])
  })

  it('does not serve non-Bitsocial content requested with a query string', async () => {
    const res = await get(`/ipfs/${notBitsocialCid}?filename=page.html`)
    expect(res.status).to.equal(403)
    expect(gatewayRequests).to.deep.equal([])
  })

  it('does not serve a directory it could not validate', async () => {
    const res = await get(`/ipfs/${dirCid}/`)
    expect(res.status).to.equal(500)
    expect(gatewayRequests).to.deep.equal([])
  })

  it('does not serve non-Bitsocial files inside a directory', async () => {
    const res = await get(`/ipfs/${dirCid}/index.html`)
    expect(res.status).to.equal(403)
    expect(gatewayRequests).to.deep.equal([])
  })

  it('does not serve non-Bitsocial files inside a directory on a subdomain gateway', async () => {
    const res = await get('/index.html', `${dirCid}.ipfs.example.com`)
    expect(res.status).to.equal(403)
    expect(gatewayRequests).to.deep.equal([])
  })

  it('keeps checking other files of an ipns name after one of its files was validated', async () => {
    expect((await get(`/ipns/${ipnsDirName}/index.html`)).status).to.equal(403)
    expect(await get(`/ipns/${ipnsDirName}/update`)).to.deep.equal({status: 200, body: 'served by gateway'})

    // only the name's root can put it in the skip-validation cache, its root is a directory that was never validated
    gatewayRequests = []
    const res = await get(`/ipns/${ipnsDirName}/index.html`)
    expect(res.status).to.equal(403)
    expect(gatewayRequests).to.deep.equal([])
  })

  it('validates the path inside a cid that an ipns record points to', async () => {
    // the gateway serves <cid>/other/update, not <cid>/update
    let res = await get(`/ipns/${ipnsPathName}/update`)
    expect(res.status).to.equal(403)
    expect(gatewayRequests).to.deep.equal([])

    res = await get(`/ipns/${ipnsPathName}/post`)
    expect(res).to.deep.equal({status: 200, body: 'served by gateway'})
    expect(catArgs).to.deep.equal([ipnsPathName, `${ipnsPathCid}/other/update`, ipnsPathName, `${ipnsPathCid}/other/post`])
  })

  it('does not serve an ipns name that does not resolve to an ipfs path', async () => {
    const res = await get(`/ipns/${ipnsNotIpfsName}/update`)
    expect(res.status).to.equal(502)
    expect(gatewayRequests).to.deep.equal([])
  })

  it('responds 504 when the content check times out', async () => {
    ipfsGateway._private.setFetchTimeoutForTests(100)
    const res = await get(`/ipfs/${slowCid}`)
    expect(res.status).to.equal(504)
    expect(gatewayRequests).to.deep.equal([])
  })
})
