import { describe, it, expect } from 'vitest';
import { saveClaudeToken, saveOpenWebNinjaKey, savePlaidKeys, KeyError } from './keys.js';

// A line break in a value would inject extra KEY=VALUE lines into server/.env
// (e.g. CLAUDE_BIN, which the server later spawns), so it must be refused before
// anything is written. These all throw before touching process.env, the keys
// file, or the network.
describe('env value hardening', () => {
  it('rejects line breaks and NUL in single-key saves', () => {
    // The in-app test runner runs inside a configured install, where these keys
    // may already be set — so check they were left unchanged, not unset. Compare
    // as booleans: a failing toBe() would print the real secret in the results.
    const before = { claude: process.env.CLAUDE_CODE_OAUTH_TOKEN, owm: process.env.OPENWEBNINJA_KEY };
    for (const bad of ['x\nCLAUDE_BIN=/tmp/evil', 'x\r\nFOO=1', 'ab\0cd']) {
      expect(() => saveClaudeToken(bad)).toThrow(KeyError);
      expect(() => saveOpenWebNinjaKey(bad)).toThrow(KeyError);
    }
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN === before.claude, 'Claude token was modified').toBe(true);
    expect(process.env.OPENWEBNINJA_KEY === before.owm, 'OpenWebNinja key was modified').toBe(true);
  });

  it('rejects line breaks in Plaid credentials before validating them', async () => {
    await expect(savePlaidKeys({ clientId: 'id', secret: 's\nCLAUDE_BIN=/tmp/evil', env: 'sandbox' }))
      .rejects.toBeInstanceOf(KeyError);
  });
});
