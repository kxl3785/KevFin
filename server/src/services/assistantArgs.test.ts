import { describe, it, expect } from 'vitest';
import { SANDBOXED_CLAUDE_ARGS, NO_TOOLS_CLAUDE_ARGS, CLAUDE_TIMEOUT_MS } from './assistant.js';

// Guards the isolation promise in CLAUDE.md: any spawn of the claude binary is
// confined to (at most) reading its own private cwd.
describe('claude spawn sandbox args', () => {
  const after = (args: string[], flag: string) => {
    const i = args.indexOf(flag);
    const out: string[] = [];
    for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
    return out;
  };

  it('read-only spawns expose only Read, scoped to the cwd', () => {
    expect(after(SANDBOXED_CLAUDE_ARGS, '--tools')).toEqual(['Read']);
    expect(after(SANDBOXED_CLAUDE_ARGS, '--allowedTools')).toEqual(['Read(./**)']);
    expect(after(SANDBOXED_CLAUDE_ARGS, '--disallowedTools'))
      .toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Glob', 'Grep']));
    expect(SANDBOXED_CLAUDE_ARGS).toContain('--strict-mcp-config');
    expect(SANDBOXED_CLAUDE_ARGS).not.toContain('-p'); // prompt travels over stdin
  });

  it('no-tools spawns disable every tool', () => {
    expect(after(NO_TOOLS_CLAUDE_ARGS, '--tools')).toEqual(['']);
    expect(NO_TOOLS_CLAUDE_ARGS).not.toContain('--allowedTools');
    expect(NO_TOOLS_CLAUDE_ARGS).toContain('--strict-mcp-config');
  });

  it('has a finite hard timeout', () => {
    expect(CLAUDE_TIMEOUT_MS).toBe(5 * 60_000);
  });
});
