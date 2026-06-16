const {execSync} = require('child_process')

let commitHash = process.env.PUBSUB_PROVIDER_COMMIT_HASH || process.env.GITHUB_SHA || ''

if (!commitHash) {
  try {
    commitHash = execSync('git rev-parse HEAD').toString().trim()
  } catch (e) {}
}

module.exports = commitHash
