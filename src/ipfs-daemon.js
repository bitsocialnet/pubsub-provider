const {spawn} = require('child_process')
const config = require('./config')
const debugIpfs = require('debug')(`${config.debugNamespace}:ipfs`)

// daemons started by this process that haven't exited yet
const ipfsProcesses = new Set()
let exitHookRegistered = false

// start the kubo daemon, resolves with the child process once the daemon is ready, rejects when it exits
// healthChecks are async functions that return a failure message when the daemon must be killed,
// they run from 'Daemon is ready' until the daemon exits
// a daemon that isn't ready after startupTimeoutMs (e.g. hung in --migrate) is killed, so the caller can retry
const startIpfsDaemon = ({binaryPath, args, env, healthChecks = [], healthCheckIntervalMs = 1000 * 60, startupTimeoutMs = 1000 * 60 * 5}) => new Promise((resolve, reject) => {
  // kill the daemons when node exits, registered once instead of once per start attempt
  if (!exitHookRegistered) {
    exitHookRegistered = true
    process.on('exit', () => {
      for (const ipfsProcess of ipfsProcesses) {
        ipfsProcess.kill()
      }
    })
  }

  // no shell: exec's 1 MiB output buffer cap would kill the long running daemon, and the pid is kubo's own
  const ipfsProcess = spawn(binaryPath, args, {env: {...process.env, ...env}})
  ipfsProcesses.add(ipfsProcess)
  console.log(`ipfs daemon process started with pid ${ipfsProcess.pid}`)
  let lastError, healthCheckInterval, startupTimeout, exited = false
  const onExit = (error) => {
    exited = true
    ipfsProcesses.delete(ipfsProcess)
    clearInterval(startupTimeout)
    clearInterval(healthCheckInterval)
    reject(error)
  }
  ipfsProcess.stderr.on('data', (data) => {
    lastError = data.toString()
    console.error(data.toString())
  })
  ipfsProcess.stdin.on('data', debugIpfs)
  ipfsProcess.stdout.on('data', (data) => {
    data = data.toString()
    debugIpfs(data)
    if (data.includes('Daemon is ready')) {
      clearInterval(startupTimeout)
      startHealthChecks()
      resolve(ipfsProcess)
    }
  })
  ipfsProcess.on('error', (e) => {
    console.error(e)
    // spawn failed, 'exit' won't be emitted
    if (ipfsProcess.pid === undefined) {
      onExit(e)
    }
  })
  ipfsProcess.on('exit', () => {
    console.error(`ipfs process with pid ${ipfsProcess.pid} exited`)
    onExit(Error(lastError))
  })
  const tryKill = () => {
    try {
      ipfsProcess.kill()
    } catch (e) {
      console.log(e)
    }
  }

  // health checks only start once the daemon is ready, kill a daemon that never gets there,
  // repeated until it exits because kubo only forces its shutdown on the second signal
  startupTimeout = setInterval(() => {
    console.log(`ipfs daemon not ready after ${startupTimeoutMs}ms, killing ipfs...`)
    tryKill()
  }, startupTimeoutMs)

  // healthchecks on gateway and kubo rpc, sometimes stops working and needs restart, dont know why
  const startHealthChecks = () => {
    if (healthCheckInterval || exited) {
      return
    }
    healthCheckInterval = setInterval(() => {
      for (const healthCheck of healthChecks) {
        healthCheck().then((failure) => {
          if (failure && !exited) {
            console.log(failure)
            tryKill()
          }
        })
      }
    }, healthCheckIntervalMs)
  }
})

module.exports = {startIpfsDaemon}
