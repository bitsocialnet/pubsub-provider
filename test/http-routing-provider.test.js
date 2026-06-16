const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs-extra')
const {expect} = require('chai')

const storePath = path.join(os.tmpdir(), `pubsub-provider-routing-${process.pid}.json`)
process.env.PUBSUB_PROVIDER_ROUTING_STORE_PATH = storePath

const {handleHttpRoutingProvider, _private} = require('../src/http-routing-provider')

const mockIp = '123.123.123.123'
const providerBody = {
  Providers: [
    {
      Schema: 'bitswap',
      Protocol: 'transport-bitswap',
      Signature: 'mx5kamm5kzxuCnVJtX3K9DEj8gKlFqXil2x/M8zDTozvzowTY6W+HOALQ2LCkTZCEz4H5qizpnHxPM/rVQ7MNBg',
      Payload: {
        Keys: [
          'bafkreigur6gzxm3ykiol7ywou3iy3obruzs2q7boizj7oznznid34dzc3e',
          'bafkreigur6gzxm3ykiol7ywou3iy3obruzs2q7boizj7oznznid34dzc3e'
        ],
        Timestamp: 1725833163372,
        AdvisoryTTL: 86400000000000,
        ID: '12D3KooWEdCRaQTjjgbtBoSMhnguznp7GHhsin8eRDEtgEso6Z1B',
        Addrs: [
          `/ip4/${mockIp}/tcp/4001`,
          `/ip4/${mockIp}/udp/4001/quic-v1`,
          `/ip4/${mockIp}/udp/4001/quic-v1/webtransport`
        ]
      }
    }
  ]
}

const request = (server, method, pathname, body) => new Promise((resolve, reject) => {
  const payload = body && JSON.stringify(body)
  const req = http.request({
    method,
    hostname: '127.0.0.1',
    port: server.address().port,
    path: pathname,
    headers: {
      'x-forwarded-for': mockIp,
      ...(payload ? {'content-length': Buffer.byteLength(payload)} : {})
    }
  }, (res) => {
    const chunks = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      resolve({
        status: res.statusCode,
        headers: res.headers,
        body: text ? JSON.parse(text) : undefined
      })
    })
  })
  req.on('error', reject)
  if (payload) {
    req.write(payload)
  }
  req.end()
})

describe('http routing provider', () => {
  let server

  before((done) => {
    server = http.createServer((req, res) => {
      handleHttpRoutingProvider(req, res)
    })
    server.listen(0, '127.0.0.1', done)
  })

  beforeEach(async () => {
    _private.resetStoreForTests()
    await fs.remove(storePath)
  })

  after((done) => {
    server.close(done)
  })

  after(async () => {
    await fs.remove(storePath)
  })

  it('stores and returns delegated routing providers', async () => {
    const putRes = await request(server, 'PUT', '/routing/v1/providers/', providerBody)
    expect(putRes.status).to.equal(200)
    expect(putRes.body).to.deep.equal({
      ProvideResults: [
        {
          Schema: 'bitswap',
          Protocol: 'transport-bitswap',
          AdvisoryTTL: 86400000000000
        }
      ]
    })

    const getRes = await request(server, 'GET', `/routing/v1/providers/${providerBody.Providers[0].Payload.Keys[0]}`)
    expect(getRes.status).to.equal(200)
    expect(getRes.headers['last-modified']).to.be.a('string')
    expect(getRes.body.Providers[0]).to.deep.equal({
      Schema: 'peer',
      ID: providerBody.Providers[0].Payload.ID,
      Protocols: [providerBody.Providers[0].Protocol],
      Addrs: providerBody.Providers[0].Payload.Addrs
    })
  })

  it('returns 404 when a CID has no providers', async () => {
    const getRes = await request(server, 'GET', '/routing/v1/providers/bafybeigvgzoolc3drupxhlevdp2ugqcrbcsqfmcek2zxiw5wctk3xjpjwy')
    expect(getRes.status).to.equal(404)
    expect(getRes.body).to.deep.equal({Providers: null})
  })

  it('normalizes raw codec CIDs to dag-pb provider records', async () => {
    const dagPbCodecCid = 'QmSf6sTLvGrCzpLcqdRLy8xUmLUhgdyAQi1VaFy7Aa2VHW'
    const rawCodecCid = 'bafkreicafdegmgvhbsc4z4whwcz3wjdoeu3jpcuy2mfckqtq5dikjelzau'
    const body = JSON.parse(JSON.stringify(providerBody))
    body.Providers[0].Payload.Keys = [dagPbCodecCid]

    const putRes = await request(server, 'PUT', '/routing/v1/providers/', body)
    expect(putRes.status).to.equal(200)

    const getRes = await request(server, 'GET', `/routing/v1/providers/${rawCodecCid}`)
    expect(getRes.status).to.equal(200)
    expect(getRes.body.Providers[0].ID).to.equal(body.Providers[0].Payload.ID)
  })
})
