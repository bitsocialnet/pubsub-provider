// stands in for `ipfs daemon` in test/ipfs-daemon.test.js
// --exit-code=<code> exits right away, --stdout-bytes=<n> writes n bytes of logs before 'Daemon is ready',
// --ready-delay-ms=<ms> waits before 'Daemon is ready', then runs until killed
const options = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => arg.slice(2).split('=')))

if (options['exit-code']) {
  process.exit(Number(options['exit-code']))
}

const stdoutBytes = Number(options['stdout-bytes'] || 0)
const readyDelayMs = Number(options['ready-delay-ms'] || 0)
const line = `${'.'.repeat(1023)}\n`
let written = 0
const writeLogs = () => {
  while (written < stdoutBytes) {
    written += line.length
    if (!process.stdout.write(line)) {
      process.stdout.once('drain', writeLogs)
      return
    }
  }
  setTimeout(() => process.stdout.write('Daemon is ready\n'), readyDelayMs)
}
writeLogs()

setInterval(() => {}, 1000)
