// Structured failure for a provider-wide refresh (SimpleFIN / Plaid), so the "Sync
// now" response can say WHICH connection failed and why without ever echoing a raw
// error. Raw errors are unsafe to forward: an AxiosError carries the Plaid secret
// and access_token in err.config, and a SimpleFIN access URL embeds its credentials.
// Everything in `failures` is therefore built from allow-listed pieces only: the
// institution name (user data) and a short reason code.

export interface ItemFailure {
  label: string;  // institution name, or "SimpleFIN connection 3" when unknown
  reason: string; // e.g. "ITEM_LOGIN_REQUIRED", "HTTP 403", "network error"
}

export class ProviderRefreshError extends Error {
  constructor(
    readonly provider: 'Plaid' | 'SimpleFIN',
    readonly total: number,
    readonly failures: ItemFailure[],
  ) {
    super(`${provider} refresh failed for ${failures.length} of ${total} ${provider === 'Plaid' ? 'item' : 'connection'}(s)`);
    this.name = 'ProviderRefreshError';
  }
}

// A reason code safe to show: Plaid's own error_code (SCREAMING_SNAKE), else the
// HTTP status, else a generic phrase. Never the message, config, or headers.
export function safePlaidReason(err: unknown): string {
  const e = err as { response?: { status?: unknown; data?: { error_code?: unknown } } } | null;
  const code = e?.response?.data?.error_code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  const status = e?.response?.status;
  if (typeof status === 'number') return `HTTP ${status}`;
  return 'error';
}

// Institution names come from the provider/user; keep them to one short printable line.
export function safeLabel(name: string | null | undefined, fallback: string): string {
  const clean = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return clean || fallback;
}
