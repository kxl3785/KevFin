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

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const desktopDir = path.join(__dirname, '..');
const repoRoot = path.join(desktopDir, '..');
const staging = path.join(desktopDir, 'staging');

const electronVersion = require(path.join(desktopDir, 'node_modules/electron/package.json')).version;

function run(cmd, cwd) {
  console.log(`\n[stage] $ ${cmd}\n        (cwd=${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

const serverDist = path.join(repoRoot, 'server/dist');
const clientDist = path.join(repoRoot, 'client/dist');
if (!fs.existsSync(serverDist)) throw new Error('server/dist missing — build the server first');
if (!fs.existsSync(clientDist)) throw new Error('client/dist missing — build the client first');

console.log('[stage] cleaning', staging);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(path.join(staging, 'server'), { recursive: true });
fs.mkdirSync(path.join(staging, 'client'), { recursive: true });

console.log('[stage] copying built server + client');
fs.cpSync(serverDist, path.join(staging, 'server/dist'), { recursive: true });
fs.cpSync(clientDist, path.join(staging, 'client/dist'), { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'server/package.json'), path.join(staging, 'server/package.json'));
fs.copyFileSync(path.join(repoRoot, 'server/package-lock.json'), path.join(staging, 'server/package-lock.json'));

console.log('[stage] installing production server dependencies');
run('npm ci --omit=dev', path.join(staging, 'server'));

console.log(`[stage] rebuilding native modules for Electron ${electronVersion}`);
const rebuildBin = path.join(desktopDir, 'node_modules/.bin/electron-rebuild');
run(`"${rebuildBin}" --version ${electronVersion} --module-dir . --only better-sqlite3 --force`, path.join(staging, 'server'));

console.log('\n[stage] done — staged at', staging);
