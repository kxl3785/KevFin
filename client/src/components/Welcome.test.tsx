import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import Welcome, { WelcomeDialog, SHOW_WELCOME_EVENT, closeWelcome, welcomeStore } from './Welcome.tsx';
import { OPEN_CONNECTIONS_EVENT, takeOpenConnectionsRequest } from '../lib/openConnections.ts';

// Static renders of the welcome guide (no DOM in this test setup). Its buttons
// are pressed by calling their onClick straight from the element tree, which
// WelcomeDialog keeps hook-free for that. localStorage and window are stubs.

const store = new Map<string, string>();
let win: EventTarget;
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  win = new EventTarget();
  (globalThis as { window?: unknown }).window = win;
  welcomeStore.reset();
  takeOpenConnectionsRequest(); // drop any request a previous test left
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { window?: unknown }).window;
});

const noop = () => {};
const dialog = (over: Partial<Parameters<typeof WelcomeDialog>[0]> = {}) =>
  WelcomeDialog({ helpOpen: false, onToggleHelp: noop, onConnect: noop, onClose: noop, ...over });

// The text of an element tree, and its buttons by their text.
function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement(node)) return text((node.props as { children?: ReactNode }).children);
  return '';
}
function buttons(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) { node.forEach(n => buttons(n, out)); return out; }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === 'button') out.push(el);
  buttons(el.props.children as ReactNode, out);
  return out;
}
function press(tree: ReactNode, label: string) {
  const b = buttons(tree).find(x => text(x.props.children as ReactNode).trim() === label);
  if (!b) throw new Error(`no button "${label}"`);
  (b.props.onClick as () => void)();
  return b;
}

describe('Welcome', () => {
  it('shows by itself on a first visit, as one page with three numbered steps', () => {
    const html = renderToStaticMarkup(<Welcome />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/<h2 id="welcome-title"[^>]*>Welcome to KevFin<\/h2>/);
    const steps = html.match(/<ol class="wel-steps">(.*?)<\/ol>/)?.[1] ?? '';
    expect(steps.match(/<li>/g)).toHaveLength(3);
    expect(steps).toContain('Connect your accounts');
    expect(steps).toContain('Add your home and anything else');
    expect(steps).toContain('Look around');
    // One page: no pager.
    expect(html).not.toMatch(/Next|Back/);
    expect(html).toContain('Connect an account');
    expect(html).toContain('Look around first');
  });

  it('stays closed once seen', () => {
    store.set('mon.welcomeSeen', '1');
    expect(renderToStaticMarkup(<Welcome />)).toBe('');
  });

  it('"Connect an account" closes it, marks it seen and asks for the Connect panel', () => {
    const asked = vi.fn();
    win.addEventListener(OPEN_CONNECTIONS_EVENT, asked);
    const onConnect = vi.fn(() => closeWelcome('connect'));
    press(dialog({ onConnect }), 'Connect an account');
    expect(onConnect).toHaveBeenCalledOnce();
    expect(store.get('mon.welcomeSeen')).toBe('1');
    expect(welcomeStore.isOpen()).toBe(false);
    expect(asked).toHaveBeenCalledOnce();
    // The request waits for a Dashboard that isn't mounted yet, and is taken once.
    expect(takeOpenConnectionsRequest()).toBe(true);
    expect(takeOpenConnectionsRequest()).toBe(false);
  });

  it('"Look around first" only closes it', () => {
    const asked = vi.fn();
    win.addEventListener(OPEN_CONNECTIONS_EVENT, asked);
    const onClose = vi.fn(() => closeWelcome());
    const onConnect = vi.fn();
    press(dialog({ onClose, onConnect }), 'Look around first');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConnect).not.toHaveBeenCalled();
    expect(store.get('mon.welcomeSeen')).toBe('1');
    expect(welcomeStore.isOpen()).toBe(false);
    expect(asked).not.toHaveBeenCalled();
    expect(takeOpenConnectionsRequest()).toBe(false);
  });

  it('folds its help away, with aria-expanded following', () => {
    const closed = renderToStaticMarkup(dialog());
    expect(closed).toMatch(/<button[^>]*class="wel-fold"[^>]*aria-expanded="false"[^>]*aria-controls="welcome-help"/);
    expect(closed).toMatch(/<div id="welcome-help" class="wel-help" hidden="">\s*<\/div>/);
    expect(closed).not.toContain('Save keys');

    const open = renderToStaticMarkup(dialog({ helpOpen: true }));
    expect(open).toMatch(/aria-expanded="true"[^>]*aria-controls="welcome-help"/);
    expect(open).not.toMatch(/id="welcome-help"[^>]*hidden/);
    expect(open).toContain('Save keys');
    expect(open).toContain('https://dashboard.plaid.com/developers/keys');
    expect(open).toContain('https://beta-bridge.simplefin.org/my-account');
    expect(open).toContain('Import transactions from a CSV');

    const onToggleHelp = vi.fn();
    press(dialog({ onToggleHelp }), 'What does each step need?');
    expect(onToggleHelp).toHaveBeenCalledOnce();
  });

  it('reopens on SHOW_WELCOME_EVENT', () => {
    const changed = vi.fn();
    const unsubscribe = welcomeStore.subscribe(changed); // what the mounted component does
    closeWelcome();
    expect(renderToStaticMarkup(<Welcome />)).toBe('');
    win.dispatchEvent(new Event(SHOW_WELCOME_EVENT));
    expect(welcomeStore.isOpen()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2); // closed, then opened
    expect(renderToStaticMarkup(<Welcome />)).toContain('Welcome to KevFin');
    // Still marked seen: reopening doesn't make it pop up on the next visit.
    expect(store.get('mon.welcomeSeen')).toBe('1');
    unsubscribe();
    closeWelcome();
    win.dispatchEvent(new Event(SHOW_WELCOME_EVENT)); // nobody listening any more
    expect(welcomeStore.isOpen()).toBe(false);
  });
});
