const http = require('http')
const Debug = require('debug')
const debug = Debug('pubsub-provider:previewer')

const port = 29556
process.env.BITSOCIAL_PREVIEWER_PORT = port

// const startPreviewer = async () => {
//   console.log(`previewer listening on port ${port}`)
// }
// startPreviewer()

const proxyPreviewer = async (proxy, req, res) => {
  debug(req.method, req.url, req.rawHeaders)

  // fix error 'has been blocked by CORS policy'
  res.setHeader('Access-Control-Allow-Origin', '*')

  proxy.web(req, res, {target: `http://127.0.0.1:${port}`})
}

module.exports = {proxyPreviewer}
