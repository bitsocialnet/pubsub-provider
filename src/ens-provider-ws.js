require('dotenv').config({quiet: true})
const WebSocket = require('ws')
const net = require('net')
const Debug = require('debug')
const debug = Debug('pubsub-provider:ens-provider-ws')
const {allowedMethods, allowedAddresses, bitsocialErrorMessage} = require('./ens-provider')

const cacheMaxAge = 1000 * 60 * 5
const port = 29425

const chainProviderUrl = process.env.ETH_PROVIDER_URL_WS

const chainProviderNotConnectedError = {
  code: -32603,
  message: 'chain provider websocket not connected, try again later'
}

let cache
import('quick-lru').then(QuickLRU => {
  cache = new QuickLRU.default({maxSize: 10000, maxAge: cacheMaxAge})
})

const startWebSockerServer = ({chainProviderUrl, port}) => {
  if (!chainProviderUrl) {
    return
  }

  const onChainProviderMessage = {}
  let chainProviderSocket
  let reconnectTimeout
  let closed = false
  const createChainProviderSocket = () => {
    // start chain provider websocket connection
    chainProviderSocket = new WebSocket(chainProviderUrl)
    chainProviderSocket.on('open', () => {
      debug('connected to chain provider websocket')
    })
    chainProviderSocket.on('close', () => {
      // the chain provider won't answer the requests sent on this socket anymore, fail them now
      for (const id in onChainProviderMessage) {
        onChainProviderMessage[id]({jsonrpc: '2.0', error: chainProviderNotConnectedError})
      }
      if (closed) {
        return
      }
      debug('disconnected from chain provider websocket, reconnecting in 5s...')
      reconnectTimeout = setTimeout(() => {
        createChainProviderSocket()
      }, 5000)
    })
    chainProviderSocket.on('error', (error) => {
      console.error('chain provider websocket error:', error)
    })
    chainProviderSocket.on('message', (message) => {
      message = message.toString()
      let jsonMessage
      try {
        jsonMessage = JSON.parse(message)
      }
      catch (e) {
        debug(`couldn't parse chain provider websocket message: '${message}'`)
        return
      }
      debug('received from chain provider', jsonMessage)

      // proxy message from chain provider to the websocket client
      if (jsonMessage.id && onChainProviderMessage[jsonMessage.id]) {
        onChainProviderMessage[jsonMessage.id](jsonMessage)
      }
    })
  }
  const chainProviderSocketStates = {
    undefined: 'missing-chain-provider-url',
    0: 'connecting',
    1: 'open',
    2: 'closing',
    3: 'closed'
  }
  const getChainProviderSocketState = () => chainProviderSocketStates[chainProviderSocket?.readyState]

  createChainProviderSocket()

  // start websocket server
  const server = new WebSocket.Server({
    port, 
    maxPayload: 100000 // 100kb
  })
  console.log(`ens websocket proxy server listening on port ${port}`)

  // start at 1, chain provider replies are matched by truthy id
  let nextJsonRpcId = 1
  server.on('connection', (clientSocket, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress

    debug('websocket client connected', ip)
    clientSocket.on('message', (message) => {
      message = message.toString()
      let jsonMessage
      try {
        jsonMessage = JSON.parse(message)
      }
      catch (e) {
        debug(`couldn't parse websocket client message: '${message}'`)
        return
      }

      // a `to` that isn't a string is treated as missing, like before, without calling a toLowerCase it doesn't have
      const to = jsonMessage?.params?.[0]?.to
      if (!allowedMethods.has(jsonMessage?.method) || !allowedAddresses.has(typeof to === 'string' ? to.toLowerCase() : undefined)) {
        debug('received from websocket client', jsonMessage, 'forbidden')
        clientSocket.send(JSON.stringify({...bitsocialErrorMessage, id: jsonMessage?.id}))
        return
      }

      const cacheKey = message.replace(/,"id":[^,]*/, '') // remove id field or caching wont work
      const cached = cache?.get(cacheKey)
      debug('received from websocket client', jsonMessage, {cached: !!cached, chainProviderSocketState: getChainProviderSocketState()}, ip)
      if (cached) {
        clientSocket.send(JSON.stringify({...cached, id: jsonMessage.id}))
        return
      }

      // connecting, or closed and waiting to reconnect: send would throw or silently drop the request
      if (chainProviderSocket.readyState !== WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({jsonrpc: '2.0', id: jsonMessage.id, error: chainProviderNotConnectedError}))
        return
      }

      const id = nextJsonRpcId++
      chainProviderSocket.send(JSON.stringify({...jsonMessage, id}))
      // cleanup
      const cleanupTimeout = setTimeout(() => {
        delete onChainProviderMessage[id]
      }, 1000 * 60 * 10)
      onChainProviderMessage[id] = (chainProviderMessageJson) => {
        // cache successful response
        if (!chainProviderMessageJson.error) {
          cache?.set(cacheKey, chainProviderMessageJson)
        }

        // proxy message from chain provider to the websocket client
        clientSocket.send(JSON.stringify({...chainProviderMessageJson, id: jsonMessage.id}))

        // cleanup
        clearTimeout(cleanupTimeout)
        delete onChainProviderMessage[id]
      }
    })
    clientSocket.on('close', () => {
      debug('websocket client disconnected', ip)
    })
    clientSocket.on('error', (error) => {
      console.error('websocket client error:', error, ip)
    })
  })

  return {
    server,
    getChainProviderSocketState,
    // stop reconnecting and close all sockets
    close: () => {
      closed = true
      clearTimeout(reconnectTimeout)
      chainProviderSocket.terminate()
      for (const clientSocket of server.clients) {
        clientSocket.terminate()
      }
      server.close()
    }
  }
}
startWebSockerServer({chainProviderUrl, port})

// use this function in the proxy script
const proxyEnsProviderWs = (req, socket, head) => {
  const targetSocket = net.connect(port, '127.0.0.1', () => {
    // write head
    targetSocket.write(
      `GET ${req.url} HTTP/1.1\r\n` + 
      Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n'
    )
    // proxy
    socket.pipe(targetSocket).pipe(socket)
  })
  targetSocket.on('error', (err) => {
    console.error('proxy target error:', err)
    socket.destroy()
  })
  socket.on('error', (err) => {
    console.error('proxy client error:', err)
    targetSocket.destroy()
  })
}

module.exports = {
  proxyEnsProviderWs,
  _private: {startWebSockerServer}
}
