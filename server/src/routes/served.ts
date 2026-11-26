import type { Response } from 'express';
import type { Served } from '../services/storedResult.js';

// Send a stored result (services/storedResult.ts). The body is the payload
// itself, unchanged; when it was computed, and whether a newer one is being
// computed right now, ride in two headers so the page can say "updated 9:41"
// and ask again once the refresh has landed (client: hooks/useApi.ts).
export const COMPUTED_AT_HEADER = 'X-KevFin-Computed-At';
export const REFRESHING_HEADER = 'X-KevFin-Refreshing';

export function sendServed<T>(res: Response, served: Served<T>): void {
  res.setHeader(COMPUTED_AT_HEADER, String(served.computedAt));
  res.setHeader(REFRESHING_HEADER, served.refreshing ? '1' : '0');
  // The same URL answers differently a moment later: never reuse a response.
  res.setHeader('Cache-Control', 'no-store');
  res.json(served.value);
}
