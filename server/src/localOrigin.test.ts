import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The guard reads KEVFIN_ALLOWED_HOSTS / NODE_ENV when the module loads / is called.
async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return await import('./localOrigin.js');
}

const saved = { ...process.env };
beforeEach(() => { delete process.env.KEVFIN_ALLOWED_HOSTS; });
afterEach(() => { process.env = { ...saved }; });

describe('checkLocalRequest', () => {
  it('accepts local-looking hosts with no Origin (non-browser callers)', async () => {
    const { checkLocalRequest } = await load();
    for (const h of ['localhost:3001', '127.0.0.1:3001', '[::1]:3001', '192.168.1.5', 'nas:3001',
      'kevfin.local', 'box.lan', 'x.home.arpa', 'me.tailnet.ts.net', 'app.localhost:5173']) {
      expect(checkLocalRequest(h, undefined), h).toBeNull();
    }
  });

  it('refuses a public hostname (DNS rebinding)', async () => {
    const { checkLocalRequest } = await load();
    expect(checkLocalRequest('evil.com:3001', undefined)).toMatch(/KEVFIN_ALLOWED_HOSTS/);
    expect(checkLocalRequest(undefined, undefined)).toMatch(/Blocked/);
  });

  it('refuses cross-site requests even to a local host', async () => {
    const { checkLocalRequest } = await load({ NODE_ENV: 'production' });
    expect(checkLocalRequest('localhost:3001', 'https://evil.com', 'cross-site')).toMatch(/Cross-site/);
    expect(checkLocalRequest('localhost:3001', 'https://evil.com')).toMatch(/Cross-origin/);
    expect(checkLocalRequest('localhost:3001', 'null')).toMatch(/Cross-origin/);
  });

  it('allows a same-origin browser request', async () => {
    const { checkLocalRequest } = await load({ NODE_ENV: 'production' });
    expect(checkLocalRequest('localhost:3001', 'http://localhost:3001', 'same-origin')).toBeNull();
  });

  it('allows a different local Origin only outside production (Vite proxy)', async () => {
    const dev = await load({ NODE_ENV: 'development' });
    expect(dev.checkLocalRequest('localhost:3001', 'http://localhost:5173')).toBeNull();
    expect(dev.checkLocalRequest('localhost:3001', 'https://evil.com')).toMatch(/Cross-origin/);
    const prod = await load({ NODE_ENV: 'production' });
    expect(prod.checkLocalRequest('localhost:3001', 'http://localhost:5173')).toMatch(/Cross-origin/);
  });

  it('honors KEVFIN_ALLOWED_HOSTS for Host and Origin', async () => {
    const { checkLocalRequest } = await load({ KEVFIN_ALLOWED_HOSTS: 'Kevfin.Example.com, other.net', NODE_ENV: 'production' });
    expect(checkLocalRequest('kevfin.example.com', undefined)).toBeNull();
    // behind a proxy that rewrites Host to the upstream
    expect(checkLocalRequest('localhost:3001', 'https://kevfin.example.com')).toBeNull();
    expect(checkLocalRequest('evil.com', undefined)).toMatch(/Blocked/);
  });
});
