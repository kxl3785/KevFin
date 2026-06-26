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

  // Bundle the native claude CLI (if staged) at resources/claude/, where the app
  // looks for CLAUDE_BIN. Done here (not via extraResources) so the exec bit
  // survives and a missing dir doesn't fail the build.
  const claudeSrc = path.join(__dirname, '..', 'staging', 'claude');
  const claudeBin = path.join(claudeSrc, electronPlatformName === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(claudeBin)) {
    const claudeDest = path.join(resources, 'claude');
    fs.rmSync(claudeDest, { recursive: true, force: true });
    fs.cpSync(claudeSrc, claudeDest, { recursive: true });
    if (electronPlatformName !== 'win32') {
      for (const f of fs.readdirSync(claudeDest)) {
        try { fs.chmodSync(path.join(claudeDest, f), 0o755); } catch { /* ignore */ }
      }
    }
    console.log(`[afterPack] bundled claude -> ${claudeDest}`);
  }
};
