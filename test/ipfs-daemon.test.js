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
})
