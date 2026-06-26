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
const path = require('path');

const desktopDir = path.join(__dirname, '..');
const repoRoot = path.join(desktopDir, '..');
const staging = path.join(desktopDir, 'staging');
const stagedServer = path.join(staging, 'server');

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

  console.log('\n[stage] done — staged at', staging);
})().catch(err => { console.error(err); process.exit(1); });
