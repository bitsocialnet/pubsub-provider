const os = require('os')
const path = require('path')
const {once} = require('events')
const {expect} = require('chai')

const {startIpfsDaemon} = require('../src/ipfs-daemon')

const fakeIpfsDaemonPath = path.join(__dirname, 'fixtures', 'fake-ipfs-daemon.js')
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// start test/fixtures/fake-ipfs-daemon.js instead of kubo
const startFakeIpfsDaemon = (fakeArgs, options = {}) => startIpfsDaemon({
  binaryPath: process.execPath,
  args: [fakeIpfsDaemonPath, 'daemon', ...fakeArgs],
  env: {IPFS_PATH: path.join(os.tmpdir(), 'pubsub-provider-fake-ipfs')},
  healthChecks: [],
  ...options
})

const hasExited = (ipfsProcess) => ipfsProcess.exitCode !== null || ipfsProcess.signalCode !== null
const stopIpfsDaemon = async (ipfsProcess) => {
  if (!hasExited(ipfsProcess)) {
    ipfsProcess.kill()
    await once(ipfsProcess, 'exit')
  }
}

describe('ipfs daemon', () => {
  it('keeps the daemon running after it writes more than 1 MiB of logs', async () => {
    const ipfsProcess = await startFakeIpfsDaemon([`--stdout-bytes=${2 * 1024 * 1024}`])
    try {
      await sleep(50)
      expect(hasExited(ipfsProcess)).to.equal(false)
    }
    finally {
      await stopIpfsDaemon(ipfsProcess)
    }
  })

  it('does not leave health checks or exit hooks behind when the daemon keeps exiting at startup', async () => {
    let healthCheckCount = 0
    const healthChecks = [async () => {
      healthCheckCount++
    }]
    const exitListenerCount = process.listenerCount('exit')

    // like the 1s restart loop in start-ipfs.js
    for (let i = 0; i < 3; i++) {
      const error = await startFakeIpfsDaemon(['--exit-code=1'], {healthChecks, healthCheckIntervalMs: 10}).catch(e => e)
      expect(error).to.be.an('error')
    }
    await sleep(100)

    expect(healthCheckCount).to.equal(0)
    expect(process.listenerCount('exit') - exitListenerCount).to.be.at.most(1)
  })

  it('kills a daemon that is not ready by the startup deadline so the restart loop can retry', async () => {
    // e.g. a hung --migrate, health checks don't run before 'Daemon is ready'
    const error = await startFakeIpfsDaemon(['--ready-delay-ms=100000'], {startupTimeoutMs: 100}).catch(e => e)
    expect(error).to.be.an('error')
  })

  it('keeps a daemon that is ready before the startup deadline', async () => {
    const ipfsProcess = await startFakeIpfsDaemon([], {startupTimeoutMs: 500})
    try {
      await sleep(600)
      expect(hasExited(ipfsProcess)).to.equal(false)
    }
    finally {
      await stopIpfsDaemon(ipfsProcess)
    }
  })

  it('starts health checks when the daemon is ready and stops them when it exits', async () => {
    let healthCheckCount = 0
    const healthChecks = [async () => {
      healthCheckCount++
      return 'health check failed, killing ipfs...'
    }]

    // the daemon takes longer to start than the health check interval
    const ipfsProcess = await startFakeIpfsDaemon(['--ready-delay-ms=200'], {healthChecks, healthCheckIntervalMs: 20})
    try {
      // the failing health check kills the daemon once it's ready
      if (!hasExited(ipfsProcess)) {
        await once(ipfsProcess, 'exit')
      }
      expect(healthCheckCount).to.be.at.least(1)

      const healthCheckCountAfterExit = healthCheckCount
      await sleep(100)
      expect(healthCheckCount).to.equal(healthCheckCountAfterExit)
    }
    finally {
      await stopIpfsDaemon(ipfsProcess)
    }
  })

  it('kills the daemon when a health check throws', async () => {
    const healthChecks = [async () => {
      throw Error('health check threw')
    }]
    // outside mocha, an unhandled rejection exits the whole provider process
    const unhandledRejections = []
    const onUnhandledRejection = (reason) => unhandledRejections.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)

    const ipfsProcess = await startFakeIpfsDaemon([], {healthChecks, healthCheckIntervalMs: 20})
    try {
      if (!hasExited(ipfsProcess)) {
        await Promise.race([once(ipfsProcess, 'exit'), sleep(1000)])
      }
      expect(unhandledRejections).to.deep.equal([])
      expect(ipfsProcess.signalCode).to.equal('SIGTERM')
    }
    finally {
      process.off('unhandledRejection', onUnhandledRejection)
      await stopIpfsDaemon(ipfsProcess)
    }
  })
})
