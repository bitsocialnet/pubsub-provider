const {spawn} = require('child_process')
const config = require('./config')
const debugIpfs = require('debug')(`${config.debugNamespace}:ipfs`)

// start the kubo daemon, resolves with the child process once the daemon is ready, rejects when it exits
// healthChecks are async functions that return a failure message when the daemon must be killed
const startIpfsDaemon = ({binaryPath, args, env, healthChecks = [], healthCheckIntervalMs = 1000 * 60}) => new Promise((resolve, reject) => {
  // no shell: exec's 1 MiB output buffer cap would kill the long running daemon, and the pid is kubo's own
  const ipfsProcess = spawn(binaryPath, args, {env: {...process.env, ...env}})
  console.log(`ipfs daemon process started with pid ${ipfsProcess.pid}`)
  let lastError
  ipfsProcess.stderr.on('data', (data) => {
    lastError = data.toString()
    console.error(data.toString())
  })
  ipfsProcess.stdin.on('data', debugIpfs)
  ipfsProcess.stdout.on('data', (data) => {
    data = data.toString()
    debugIpfs(data)
    if (data.includes('Daemon is ready')) {
      resolve(ipfsProcess)
    }
  })
  ipfsProcess.on('error', (e) => {
    console.error(e)
    // spawn failed, 'exit' won't be emitted
    if (ipfsProcess.pid === undefined) {
      reject(e)
    }
  })
  ipfsProcess.on('exit', () => {
    console.error(`ipfs process with pid ${ipfsProcess.pid} exited`)
    reject(Error(lastError))
  })
  const tryKill = () => {
    try {
      ipfsProcess.kill()
    } catch (e) {
      console.log(e)
    }
  }
  process.on('exit', () => {
    tryKill()
  })

  // healthchecks on gateway and kubo rpc, sometimes stops working and needs restart, dont know why
  for (const healthCheck of healthChecks) {
    setInterval(async () => {
      const failure = await healthCheck()
      if (failure) {
        console.log(failure)
        tryKill()
      }
    }, healthCheckIntervalMs)
  }
})

module.exports = {startIpfsDaemon}
