// Ad-hoc sign the macOS app so downloads open via System Settings → "Open Anyway"
// instead of the "app is damaged" error that unsigned Apple-silicon builds get.
// No Apple Developer account needed. Hardened runtime stays off on purpose:
// with an ad-hoc identity it makes Electron fail library validation and crash.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  // Fail the build if the bundle signature is not valid.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
}
