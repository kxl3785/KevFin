// Labels for the dashboard's "change since last visit" badge: WHEN that visit was,
// in the viewer's local time. `at` is the ISO timestamp stamped on the stored
// session snapshot; snapshots saved before timestamps existed have none.

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// Short label shown next to the delta: "since 2:15 PM" (today), "since yesterday",
// "since Oct 22" (this year), "since Oct 22, 2025" (earlier years).
export function sinceLabel(atIso: string | undefined, now: Date = new Date()): string {
  const at = atIso ? new Date(atIso) : null;
  if (!at || Number.isNaN(at.getTime())) return 'since last visit';

  if (sameLocalDay(at, now)) {
    return `since ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  // setDate (not -24h) so DST changeover days still land on the previous calendar day.
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalDay(at, yesterday)) return 'since yesterday';

  return at.getFullYear() === now.getFullYear()
    ? `since ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : `since ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

// Full local date + time for the badge tooltip ("Oct 22, 2026, 2:15 PM"), or null
// when there's no usable timestamp.
export function visitTitle(atIso: string | undefined): string | null {
  const at = atIso ? new Date(atIso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return at.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
