const net = require('net')
const {once} = require('events')
const WebSocket = require('ws')
const {expect} = require('chai')

// allowed by ens-provider allowedMethods and allowedAddresses
const universalResolver = '0xc0497e381f536be9ce14b0dd3817cbcae57d2f62'

// ens-provider.js starts an http server on a fixed port when required, stub the parts ens-provider-ws uses
const ensProviderPath = require.resolve('../src/ens-provider')
const ensProviderModule = require.cache[ensProviderPath]
require.cache[ensProviderPath] = ensProviderModule || {
  id: ensProviderPath,
  filename: ensProviderPath,
  loaded: true,
  exports: {
    allowedMethods: new Set(['eth_chainId', 'eth_call', 'net_version']),
    allowedAddresses: new Set([undefined, universalResolver]),
    bitsocialErrorMessage: {jsonrpc: '2.0', error: {code: 429, message: 'Forbidden Bitsocial Content Only, Method Or Address Not Allowed'}}
  }
}
const {_private: {startWebSockerServer}} = require('../src/ens-provider-ws')
if (!ensProviderModule) {
  delete require.cache[ensProviderPath]
}
let nextData = 0
// unique params so responses are never served from the module level cache
const ethCall = (id) => ({jsonrpc: '2.0', id, method: 'eth_call', params: [{to: universalResolver, data: `0x${(nextData++).toString(16).padStart(2, '0')}`}, 'latest']})

const nextMessage = (socket) => new Promise((resolve) => {
  socket.once('message', (message) => resolve(JSON.parse(message.toString())))
})

const waitForChainProviderSocketState = async (proxy, state) => {
  while (proxy.getChainProviderSocketState() !== state) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('ens provider websocket', () => {
  let chainProvider, proxy, client, onChainProviderConnection

  const startChainProvider = async () => {
    chainProvider = new WebSocket.Server({port: 0, host: '127.0.0.1'})
    chainProvider.on('connection', (socket) => onChainProviderConnection(socket))
    await once(chainProvider, 'listening')
    return `ws://127.0.0.1:${chainProvider.address().port}`
  }

  const startProxy = async (chainProviderUrl) => {
    proxy = startWebSockerServer({chainProviderUrl, port: 0})
    await once(proxy.server, 'listening')
    client = new WebSocket(`ws://127.0.0.1:${proxy.server.address().port}`)
    await once(client, 'open')
  }

  afterEach(async () => {
    client?.terminate()
    proxy?.close()
    if (chainProvider) {
      for (const socket of chainProvider.clients) {
        socket.terminate()
      }
      await new Promise(resolve => chainProvider.close(resolve))
    }
    client = proxy = chainProvider = undefined
  })

  it('answers the first request sent to the chain provider', async () => {
    onChainProviderConnection = (socket) => socket.on('message', (message) => {
      const {id} = JSON.parse(message.toString())
      socket.send(JSON.stringify({jsonrpc: '2.0', id, result: '0x01'}))
    })
    await startProxy(await startChainProvider())
    await waitForChainProviderSocketState(proxy, 'open')

    client.send(JSON.stringify(ethCall(11)))
    expect(await nextMessage(client)).to.deep.equal({jsonrpc: '2.0', id: 11, result: '0x01'})
  })

  it('replies with an error while the chain provider socket is connecting', async () => {
    // accepts the tcp connection but never answers the websocket handshake
    const sockets = []
    const tcpServer = net.createServer((socket) => sockets.push(socket))
    tcpServer.listen(0, '127.0.0.1')
    await once(tcpServer, 'listening')
    try {
      await startProxy(`ws://127.0.0.1:${tcpServer.address().port}`)
      expect(proxy.getChainProviderSocketState()).to.equal('connecting')

      client.send(JSON.stringify(ethCall(12)))
      const reply = await nextMessage(client)
      expect(reply.id).to.equal(12)
      expect(reply.error).to.be.an('object')
    }
    finally {
      sockets.forEach(socket => socket.destroy())
      tcpServer.close()
    }
  })

  it('fails pending requests when the chain provider socket closes', async () => {
    // never answers, closes the connection instead
    onChainProviderConnection = (socket) => socket.on('message', () => socket.close())
    await startProxy(await startChainProvider())
    await waitForChainProviderSocketState(proxy, 'open')

    client.send(JSON.stringify(ethCall(13)))
    const reply = await nextMessage(client)
    expect(reply.id).to.equal(13)
    expect(reply.error).to.be.an('object')
  })

  it('replies with an error while waiting to reconnect to the chain provider', async () => {
    onChainProviderConnection = (socket) => socket.close()
    await startProxy(await startChainProvider())
    await waitForChainProviderSocketState(proxy, 'closed')

    client.send(JSON.stringify(ethCall(14)))
    const reply = await nextMessage(client)
    expect(reply.id).to.equal(14)
    expect(reply.error).to.be.an('object')
  })

  it('replies to malformed requests without crashing', async () => {
    onChainProviderConnection = (socket) => socket.on('message', (message) => {
      const {id} = JSON.parse(message.toString())
      socket.send(JSON.stringify({jsonrpc: '2.0', id, result: '0x1'}))
    })
    await startProxy(await startChainProvider())
    await waitForChainProviderSocketState(proxy, 'open')

    client.send('null')
    expect((await nextMessage(client)).error).to.be.an('object')

    // `to` is not a string but has a toLowerCase property
    client.send(JSON.stringify({jsonrpc: '2.0', id: 16, method: 'eth_call', params: [{to: {toLowerCase: 1}}, 'latest']}))
    expect((await nextMessage(client)).id).to.equal(16)

    client.send(JSON.stringify({jsonrpc: '2.0', id: 15, method: 'eth_chainId'}))
    expect(await nextMessage(client)).to.deep.equal({jsonrpc: '2.0', id: 15, result: '0x1'})
  })
})
