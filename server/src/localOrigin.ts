import net from 'net';
import type { Request, Response, NextFunction } from 'express';

// There is no login: the app's only protection is that it's reachable from your
// own machine/LAN/tailnet. A website you happen to visit must not be able to
// borrow your browser to talk to it, so /api enforces two things:
//  1. Host must be a local-looking name (blocks DNS rebinding, where evil.com
//     is re-pointed at 127.0.0.1 so the browser treats our API as same-origin).
//  2. A browser-supplied Origin must be this same site (blocks cross-site
//     fetch/forms, incl. text/plain POSTs that skip CORS preflight — e.g. to
//     /api/data/reset). The client is always same-origin, so no CORS is needed.
// Non-browser callers send no Origin and are unaffected.
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home.arpa', '.ts.net'];
// Extra names for reverse proxies / custom DNS, e.g. KEVFIN_ALLOWED_HOSTS=kevfin.example.com
const EXTRA_HOSTS = (process.env.KEVFIN_ALLOWED_HOSTS ?? '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

// "host:port" / "[::1]:port" / "host" -> lowercase hostname without port or brackets.
export function hostnameOf(hostHeader: string): string {
  const m = hostHeader.trim().toLowerCase().match(/^(\[[^\]]*\]|[^:]*)(?::\d*)?$/);
  return (m ? m[1] : hostHeader).replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLocalHostname(h: string): boolean {
  return h === 'localhost' || net.isIP(h) !== 0 || !h.includes('.') ||
    LOCAL_SUFFIXES.some(s => h.endsWith(s)) || EXTRA_HOSTS.includes(h);
}

// Returns an error message when the request should be refused, else null.
export function checkLocalRequest(hostHeader: string | undefined, origin: string | undefined, secFetchSite?: string): string | null {
  const host = hostHeader ? hostnameOf(hostHeader) : '';
  if (!host || !isLocalHostname(host)) {
    return `Blocked request for host "${host}". If this is your own hostname, add it to KEVFIN_ALLOWED_HOSTS in server/.env (comma-separated) and restart.`;
  }
  if (secFetchSite === 'cross-site') return 'Cross-site requests are not allowed.';
  if (origin === undefined) return null;

  let o: URL;
  try { o = new URL(origin); } catch { return 'Cross-origin requests are not allowed.'; }
  const oHost = hostnameOf(o.host);
  // Normal case: the page and the API share one origin (prod, Electron, LAN/Tailscale).
  if (o.host.toLowerCase() === hostHeader!.trim().toLowerCase()) return null;
  // Vite's dev proxy rewrites Host to the API target (localhost:3001) while the
  // browser's Origin stays the dev server (localhost:5173), so outside production
  // accept any local-looking Origin; the Host check above still stops rebinding.
  if (process.env.NODE_ENV !== 'production' && isLocalHostname(oHost)) return null;
  // Behind a reverse proxy that rewrites Host: trust only names the owner listed.
  if (EXTRA_HOSTS.includes(oHost)) return null;
  return `Cross-origin request from "${oHost}" refused. If that's your own hostname (e.g. behind a reverse proxy), add it to KEVFIN_ALLOWED_HOSTS in server/.env and restart.`;
}

// Express middleware: mount on /api.
export function localOriginGuard(req: Request, res: Response, next: NextFunction) {
  const err = checkLocalRequest(req.headers.host, req.headers.origin, req.headers['sec-fetch-site'] as string | undefined);
  if (err) return res.status(403).json({ error: err });
  next();
}
