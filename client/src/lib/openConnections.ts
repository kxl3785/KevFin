// "Open the Accounts card's Connect panel", asked for from outside the Dashboard
// (the welcome guide's "Connect an account" button). Same style as
// SHOW_WELCOME_EVENT: a window event, so the asker needs no reference to the page.
//
// The asker may be on another tab, where the Dashboard isn't mounted to hear the
// event. So the request is also left pending here: App.tsx hears the event and
// navigates to the Dashboard, and the Dashboard takes the pending request when it
// mounts (or straight away, if it was already showing) and opens the panel.
export const OPEN_CONNECTIONS_EVENT = 'kevfin:open-connections';

let pending = false;

export function requestOpenConnections(): void {
  pending = true;
  window.dispatchEvent(new Event(OPEN_CONNECTIONS_EVENT));
}

// True once per request: the Dashboard's mount check and its event listener can
// both ask without opening (and scrolling) twice.
export function takeOpenConnectionsRequest(): boolean {
  const was = pending;
  pending = false;
  return was;
}
