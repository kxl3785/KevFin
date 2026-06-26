// electron-builder strips `node_modules` from extraResources (hardcoded), so the
// staged server's production deps — including the Electron-ABI better-sqlite3 —
// never make it into the bundle. Copy them in ourselves after the app dir is
// assembled, before it's packaged into the .dmg / installer.

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');

  const src = path.join(__dirname, '..', 'staging', 'server', 'node_modules');
  const dest = path.join(resources, 'server', 'node_modules');

  if (!fs.existsSync(src)) throw new Error(`[afterPack] staged node_modules missing: ${src} (run the stage step first)`);

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[afterPack] copied server node_modules -> ${dest}`);
};
