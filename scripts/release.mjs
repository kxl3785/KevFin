#!/usr/bin/env node
// Cut a KevFin release: bump the three package.json versions in lockstep, commit
// just those files, and create an annotated git tag. Tags are the source of
// truth — the running app derives its displayed version from `git describe`
// (see server/src/services/data.ts:appVersion), so this tag is what users see.
//
//   npm run release            # patch  (1.0.0 -> 1.0.1)
//   npm run release minor      # 1.0.0 -> 1.1.0
//   npm run release major      # 1.0.0 -> 2.0.0
//   npm run release 1.4.2      # set an explicit version
//
// Bump rules: patch = fixes/polish, minor = new features, major = breaking
// schema/data changes or a redesign.

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = ['package.json', 'server/package.json', 'client/package.json'].map(p => path.join(root, p));

const git = (cmd) => execSync(`git ${cmd}`, { cwd: root }).toString().trim();
const die = (msg) => { console.error(`✖ ${msg}`); process.exit(1); };

// Current version is read from the root package.json.
const current = JSON.parse(readFileSync(PKGS[0], 'utf8')).version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!m) die(`Root package.json version "${current}" is not plain semver.`);
let [, major, minor, patch] = m.map(Number);

const arg = (process.argv[2] || 'patch').toLowerCase();
let next;
if (arg === 'patch') next = `${major}.${minor}.${patch + 1}`;
else if (arg === 'minor') next = `${major}.${minor + 1}.0`;
else if (arg === 'major') next = `${major + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else die(`Unknown bump "${arg}". Use patch | minor | major | X.Y.Z`);

const tag = `v${next}`;

// Guardrails: don't clobber an existing tag, and don't fold unrelated WIP into
// the release commit — we stage only the package.json files ourselves.
if (git('tag -l ' + tag)) die(`Tag ${tag} already exists.`);

console.log(`Releasing ${current} -> ${next}  (tag ${tag})`);

// Bump each file with a minimal, formatting-preserving edit of the first
// "version" field.
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
console.log(`  Push it with:  git push && git push origin ${tag}`);
