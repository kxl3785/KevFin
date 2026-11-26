// The Investments endpoints answer from a stored result (server:
// services/storedResult.ts) and describe it in two response headers:
//   X-KevFin-Computed-At   when the result was computed (ms since the epoch)
//   X-KevFin-Refreshing    '1' while the server is computing a newer one
// This turns them into what the page shows ("Updated 9:41 AM") and how soon to
// ask again. Endpoints that don't send the headers give null.

export interface Served { computedAt: number; refreshing: boolean }

export function servedFrom(headers: { get(name: string): string | null }): Served | null {
  const at = Number(headers.get('X-KevFin-Computed-At'));
  if (!Number.isFinite(at) || at <= 0) return null;
  return { computedAt: at, refreshing: headers.get('X-KevFin-Refreshing') === '1' };
}

// How long to wait before asking again while the server says "refreshing":
// quick at first (a refresh usually lands within a second or two), then backing
// off, since every ask returns the whole stored result again.
export function pollDelay(polls: number): number {
  return Math.min(1500 * 2 ** Math.max(0, polls), 15_000);
}

// One line for several results shown together: as old as the oldest of them,
// refreshing while any of them is. Null until at least one has arrived.
export function combineServed(all: (Served | null | undefined)[]): Served | null {
  const got = all.filter((s): s is Served => !!s);
  if (!got.length) return null;
  return { computedAt: Math.min(...got.map(s => s.computedAt)), refreshing: got.some(s => s.refreshing) };
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// "Updated 9:41 AM" (today), "Updated yesterday, 9:41 AM", "Updated Nov 20,
// 9:41 AM" (earlier), in the viewer's local time.
export function updatedLabel(computedAt: number, now: Date = new Date()): string {
  const at = new Date(computedAt);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameLocalDay(at, now)) return `Updated ${time}`;
  // setDate (not -24h) so DST changeover days still land on the previous calendar day.
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalDay(at, yesterday)) return `Updated yesterday, ${time}`;
  const day = at.toLocaleDateString('en-US', at.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  return `Updated ${day}, ${time}`;
}
