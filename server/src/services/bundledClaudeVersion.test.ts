import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MIN_CLAUDE_CODE_VERSION } from './assistant.js';

// The Docker image and the desktop app each bundle their own Claude Code binary,
// pinned in two files outside the server package. Upgrading CLAUDE_MODEL without
// raising those pins breaks the assistant in both builds (every spawn fails with
// "does not support this model") while a dev machine with a newer `claude` on PATH
// keeps working — so nothing else catches it. This reads the pins and holds them
// to MIN_CLAUDE_CODE_VERSION and to each other.
//
// Both files live at the repo root, which isn't present where the tests run from
// a packaged copy (Setup → Tests inside the Docker image ships only server/), so
// the suite skips there rather than failing on a missing file.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');
const pinned = (text: string, re: RegExp) => re.exec(text)?.[1] ?? null;
const cmp = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

const inRepo = existsSync(path.join(repoRoot, 'Dockerfile')) && existsSync(path.join(repoRoot, 'desktop/scripts/stage.js'));

describe.skipIf(!inRepo)('bundled Claude Code version', () => {
  const docker = inRepo ? pinned(read('Dockerfile'), /^ARG CLAUDE_CODE_VERSION=(\d+\.\d+\.\d+)\s*$/m) : null;
  const desktop = inRepo ? pinned(read('desktop/scripts/stage.js'), /^const CLAUDE_VERSION = '(\d+\.\d+\.\d+)';/m) : null;

  it('is pinned in the Dockerfile and passed to the installer', () => {
    expect(docker).not.toBeNull();
    // An unpinned install stays at whatever the cached layer first fetched.
    expect(read('Dockerfile')).toMatch(/install\.sh \| bash -s "\$\{CLAUDE_CODE_VERSION\}"/);
  });

  it('is pinned in the desktop staging script', () => {
    expect(desktop).not.toBeNull();
  });

  it('is the same in both builds', () => {
    expect(docker).toBe(desktop);
  });

  it('is new enough for the assistant model', () => {
    expect(cmp(docker!, MIN_CLAUDE_CODE_VERSION)).toBeGreaterThanOrEqual(0);
    expect(cmp(desktop!, MIN_CLAUDE_CODE_VERSION)).toBeGreaterThanOrEqual(0);
  });
});
