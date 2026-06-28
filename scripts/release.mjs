#!/usr/bin/env node
// Cut a KevFin release in one shot. Tags are the source of truth — the running
// app derives its displayed version from `git describe` (see
// server/src/services/data.ts:appVersion), so the tag is what users see.
//
//   npm run release                 # auto: infer bump, verify, tag, push, GitHub Release
//   npm run release minor           # force a minor bump
//   npm run release major
//   npm run release 1.4.2           # set an explicit version
//   npm run release -- --no-verify          # skip the build+test gate
//   npm run release -- --no-push            # tag locally, don't push
//   npm run release -- --no-github-release  # push the tag but don't publish a Release page
//   npm run release -- --dry-run            # show what it would do, change nothing
//
// Publishing the GitHub Release needs the `gh` CLI installed and logged in; if
// it's missing the step is skipped (the tag is still pushed).
//
// Auto bump inference (commits since the last tag):
//   major  if any commit is a breaking change ("BREAKING CHANGE" or "type!:")
//   minor  if any commit is a feature ("feat:" / "feat(scope):")
//   patch  otherwise
//
// The release commit contains ONLY the version bump, so unrelated work in your
// working tree is never folded into a release.

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = ['package.json', 'server/package.json', 'client/package.json'].map(p => path.join(root, p));

const git = (cmd) => execSync(`git ${cmd}`, { cwd: root }).toString().trim();
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const die = (msg) => { console.error(`✖ ${msg}`); process.exit(1); };

// --- args ---------------------------------------------------------------
const argv = process.argv.slice(2);
const noVerify = argv.includes('--no-verify');
const noPush = argv.includes('--no-push');
const noGithubRelease = argv.includes('--no-github-release');
const dryRun = argv.includes('--dry-run');
const bumpArg = argv.find(a => !a.startsWith('-')); // patch|minor|major|X.Y.Z, optional

// --- current version + last tag ----------------------------------------
const current = JSON.parse(readFileSync(PKGS[0], 'utf8')).version;
const cm = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!cm) die(`Root package.json version "${current}" is not plain semver.`);
let [, major, minor, patch] = cm.map(Number);

let lastTag = '';
try { lastTag = git('describe --tags --abbrev=0'); } catch { /* no tags yet */ }

// --- decide the bump ----------------------------------------------------
function inferBump() {
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const log = git(`log ${range} --pretty=format:%s%n%b`);
  if (!log) die(`No commits since ${lastTag || 'the start'} — nothing to release.`);
  if (/^\w+(\(.+\))?!:/m.test(log) || /BREAKING CHANGE/.test(log)) return 'major';
  if (/^feat(\(.+\))?:/m.test(log)) return 'minor';
  return 'patch';
}

const bump = bumpArg ?? inferBump();
let next;
if (bump === 'patch') next = `${major}.${minor}.${patch + 1}`;
else if (bump === 'minor') next = `${major}.${minor + 1}.0`;
else if (bump === 'major') next = `${major + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else die(`Unknown bump "${bump}". Use patch | minor | major | X.Y.Z`);

const tag = `v${next}`;
if (git(`tag -l ${tag}`)) die(`Tag ${tag} already exists.`);

console.log(`→ ${current} -> ${next}  (${bumpArg ? 'forced' : 'inferred'} ${bump}, tag ${tag})`);

if (dryRun) {
  console.log('Dry run — no files changed, nothing committed, tagged, or pushed.');
  process.exit(0);
}

// --- verify (build + tests) --------------------------------------------
if (noVerify) {
  console.log('⚠ Skipping build+test verification (--no-verify).');
} else {
  console.log('Verifying: npm run build && npm test ...');
  try {
    run('npm run build');
    run('npm test');
  } catch {
    die('Verification failed — fix the build/tests or pass --no-verify.');
  }
}

// --- bump, commit, tag --------------------------------------------------
for (const p of PKGS) {
  const src = readFileSync(p, 'utf8');
  const out = src.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`);
  if (out === src) die(`Could not find a version field in ${p}`);
  writeFileSync(p, out);
}
git(`add ${PKGS.map(p => `"${p}"`).join(' ')}`);
git(`commit -m "release: ${tag}"`);
git(`tag -a ${tag} -m "${tag}"`);
console.log(`✔ Committed and tagged ${tag}`);

// --- push ---------------------------------------------------------------
const hasRemote = (() => { try { return !!git('remote'); } catch { return false; } })();
if (noPush) {
  console.log(`Tagged locally. Push with:  git push --follow-tags`);
} else if (!hasRemote) {
  console.log('No git remote configured — skipping push.');
} else {
  console.log('Pushing commit + tag ...');
  run('git push --follow-tags');
  console.log(`✔ Pushed ${tag}`);
}

// --- GitHub Release -----------------------------------------------------
// Turn the pushed tag into a published Release page with auto-generated
// notes. Needs the `gh` CLI (logged in) and the tag to be on the remote, so
// it's skipped when we didn't push or gh isn't available.
const hasGh = (() => { try { execSync('gh --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
if (noGithubRelease) {
  console.log('Skipping GitHub Release (--no-github-release).');
} else if (noPush || !hasRemote) {
  console.log('Tag not pushed — skipping GitHub Release.');
} else if (!hasGh) {
  console.log(`gh CLI not found — skipping GitHub Release. Create it later with:\n  gh release create ${tag} --generate-notes`);
} else {
  console.log('Creating GitHub Release ...');
  run(`gh release create ${tag} --title "${tag}" --generate-notes`);
  console.log(`✔ Published GitHub Release ${tag}`);
}
