import { describe, it, expect } from 'vitest';
import { dropBlankEnv } from './emptyEnv.js';

describe('dropBlankEnv', () => {
  it('removes blank values (so dotenv can fill them) but keeps real ones', () => {
    const env: NodeJS.ProcessEnv = { A: '', B: '   ', C: 'x', D: undefined };
    dropBlankEnv(['A', 'B', 'C', 'D', 'E'], env);
    expect('A' in env).toBe(false);
    expect('B' in env).toBe(false);
    expect(env.C).toBe('x');
  });
});
