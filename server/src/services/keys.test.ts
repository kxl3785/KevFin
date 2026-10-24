import { describe, it, expect } from 'vitest';
import { saveClaudeToken, saveOpenWebNinjaKey, savePlaidKeys, KeyError } from './keys.js';

// A line break in a value would inject extra KEY=VALUE lines into server/.env
// (e.g. CLAUDE_BIN, which the server later spawns), so it must be refused before
// anything is written. These all throw before touching process.env, the keys
// file, or the network.
describe('env value hardening', () => {
  it('rejects line breaks and NUL in single-key saves', () => {
    for (const bad of ['x\nCLAUDE_BIN=/tmp/evil', 'x\r\nFOO=1', 'ab\0cd']) {
      expect(() => saveClaudeToken(bad)).toThrow(KeyError);
      expect(() => saveOpenWebNinjaKey(bad)).toThrow(KeyError);
    }
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('rejects line breaks in Plaid credentials before validating them', async () => {
    await expect(savePlaidKeys({ clientId: 'id', secret: 's\nCLAUDE_BIN=/tmp/evil', env: 'sandbox' }))
      .rejects.toBeInstanceOf(KeyError);
  });
});
