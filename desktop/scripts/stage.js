// Stage the built server + client for packaging.
//
// The packaged app runs the server under Electron's bundled Node, so its native
// module (better-sqlite3) must be built for Electron's ABI — but the repo's
// server/node_modules is built for the system Node (used by `npm run dev`). To
// avoid clobbering that, we assemble an isolated production copy of the server
// under desktop/staging/ and rebuild the native module there for Electron.
//
// Layout produced (electron-builder ships these as extraResources, keeping the
// server/ + client/ sibling relationship the server expects for serving the UI):
//   desktop/staging/server/{dist,node_modules,package.json}
//   desktop/staging/client/dist

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const desktopDir = path.join(__dirname, '..');
const repoRoot = path.join(desktopDir, '..');
const staging = path.join(desktopDir, 'staging');
const stagedServer = path.join(staging, 'server');

// The native, self-contained `claude` CLI to bundle so the assistant works
// out of the box (after the user signs in with their own token). Distributed as
// per-platform npm packages (the package root *is* the binary). Pinned for
// reproducible builds — bump to update.
const CLAUDE_VERSION = '2.1.193';
function claudePlatformPackage() {
  const map = {
    'darwin-arm64': '@anthropic-ai/claude-code-darwin-arm64',
    'darwin-x64': '@anthropic-ai/claude-code-darwin-x64',
    'win32-x64': '@anthropic-ai/claude-code-win32-x64',
    'win32-arm64': '@anthropic-ai/claude-code-win32-arm64',
  };
  return map[`${process.platform}-${process.arch}`] || null;
}

const electronVersion = require(path.join(desktopDir, 'node_modules/electron/package.json')).version;

(async () => {
  const serverDist = path.join(repoRoot, 'server/dist');
  const clientDist = path.join(repoRoot, 'client/dist');
  if (!fs.existsSync(serverDist)) throw new Error('server/dist missing — build the server first');
  if (!fs.existsSync(clientDist)) throw new Error('client/dist missing — build the client first');

  console.log('[stage] cleaning', staging);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(stagedServer, { recursive: true });
  fs.mkdirSync(path.join(staging, 'client'), { recursive: true });

  console.log('[stage] copying built server + client');
  fs.cpSync(serverDist, path.join(stagedServer, 'dist'), { recursive: true });
  fs.cpSync(clientDist, path.join(staging, 'client/dist'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'server/package.json'), path.join(stagedServer, 'package.json'));
  fs.copyFileSync(path.join(repoRoot, 'server/package-lock.json'), path.join(stagedServer, 'package-lock.json'));

  console.log('[stage] installing production server dependencies');
  // shell:true so `npm` resolves to npm.cmd on Windows (Node refuses to spawn
  // .cmd directly without it).
  execFileSync('npm', ['ci', '--omit=dev'], { cwd: stagedServer, stdio: 'inherit', shell: true });

  console.log(`[stage] rebuilding native modules for Electron ${electronVersion}`);
  // @electron/rebuild v4 is ESM-only — load it with dynamic import from this CJS
  // script. The programmatic API (vs the CLI shim) rebuilds the same on Windows.
  const { rebuild } = await import('@electron/rebuild');
  await rebuild({ buildPath: stagedServer, electronVersion, onlyModules: ['better-sqlite3'], force: true });

  // Bundle the matching native claude CLI (best-effort: the assistant degrades
  // to its sign-in gate if it's absent, so a fetch hiccup shouldn't fail the build).
  const claudeDir = path.join(staging, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const pkg = claudePlatformPackage();
  if (!pkg) {
    console.warn(`[stage] no claude binary for ${process.platform}-${process.arch} — skipping (assistant needs a manual binary)`);
  } else {
    try {
      console.log(`[stage] bundling claude ${CLAUDE_VERSION} (${pkg})`);
      // Use the system temp dir (no spaces) — npm pack's --pack-destination breaks
      // on a path with spaces under shell:true (which we need for npm.cmd on Windows).
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kevfin-claude-'));
      execFileSync('npm', ['pack', `${pkg}@${CLAUDE_VERSION}`, '--pack-destination', tmp], { stdio: 'inherit', shell: true });
      const tgz = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'));
      if (!tgz) throw new Error('npm pack produced no tarball');
      execFileSync('tar', ['xzf', path.join(tmp, tgz), '-C', tmp], { stdio: 'inherit' });
      const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
      const srcBin = [path.join(tmp, 'package', binName), path.join(tmp, 'package', 'claude')].find(p => fs.existsSync(p));
      if (!srcBin) throw new Error('claude binary not found in package');
      const destBin = path.join(claudeDir, binName);
      fs.copyFileSync(srcBin, destBin);
      if (process.platform !== 'win32') fs.chmodSync(destBin, 0o755);
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`[stage] bundled claude -> ${destBin}`);
    } catch (e) {
      console.warn('[stage] WARNING: could not bundle the claude CLI — the assistant will need a manual sign-in/binary:', e.message);
    }
  }

  console.log('\n[stage] done — staged at', staging);
})().catch(err => { console.error(err); process.exit(1); });
