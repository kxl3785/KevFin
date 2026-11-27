import { useEffect, useState, useSyncExternalStore, type Ref } from 'react';
import { useModalDialog } from '../hooks/useModalDialog.ts';
import { requestOpenConnections } from '../lib/openConnections.ts';

// First-run quick start, aimed at people who have never used the app: one screen
// with three numbered steps (connect accounts, add a home and other assets, look
// around), what leaves the computer, and one action. It shows by itself the first
// time KevFin is opened in a browser, and can be reopened any time from the
// "Welcome guide" link at the foot of Setup (which dispatches SHOW_WELCOME_EVENT).
//
// "Connect an account" closes the guide and asks the Dashboard to open its
// Connect panel (lib/openConnections.ts; App.tsx switches to the Dashboard first
// when another tab is showing). "Look around first", Escape and the backdrop just
// close it. Every way out marks the guide as seen.
//
// Every name in here is a label on screen, and the privacy line is a claim about
// what the app sends out. If one of these changes, change the guide with it:
//   - + Connect / + Plaid / Save keys / + SimpleFIN / Connect: pages/Dashboard.tsx,
//     ConnectPlaid.tsx, ConnectSimpleFIN.tsx
//   - + Add Property, the ⋯ menu's Add loan terms, Manual assets, Add a key →:
//     pages/Dashboard.tsx, AddProperty.tsx, ZillowKey.tsx
//   - Import transactions from a CSV, Download backup, Welcome guide: Setup.tsx
//   - the chat button and Turn on the AI assistant: AiAssistant.tsx, ClaudeLoginGate.tsx
//   - what is sent where: the server's services (prices, yahooMeta, expenseRatios,
//     fundHoldings, listedHoldings, edgarHoldings, secCompany, secFees, figi, zhvi,
//     zillow) and lib/merchantLogo.ts; the assistant's side is AssistantPrivacy.tsx
export const SHOW_WELCOME_EVENT = 'kevfin:show-welcome';

// localStorage flag set once the guide is closed, so it only appears by itself on
// the very first visit. It's per browser (not a server-synced preference, so a
// new device shows the guide once), and under the `mon.` prefix the rest of the
// app uses, so a backup carries it (Setup's collectLocalSettings).
const SEEN_KEY = 'mon.welcomeSeen';

function hasSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

// --- Open / closed --------------------------------------------------------------
// Kept outside React, in the style of ClaudeLoginGate's auth store, so it has one
// source no matter who opens or closes it. Read lazily: localStorage may not
// exist yet when the module loads.
let openNow: boolean | null = null;
const listeners = new Set<() => void>();

function isOpen(): boolean {
  if (openNow === null) openNow = !hasSeen();
  return openNow;
}
function setOpen(v: boolean) {
  if (isOpen() === v) return;
  openNow = v;
  for (const l of listeners) l();
}
function onShowEvent() { setOpen(true); }

// The first subscriber also starts listening for SHOW_WELCOME_EVENT, and the last
// one to leave stops.
function subscribe(l: () => void) {
  if (listeners.size === 0) window.addEventListener(SHOW_WELCOME_EVENT, onShowEvent);
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) window.removeEventListener(SHOW_WELCOME_EVENT, onShowEvent);
  };
}

/** Close the guide and remember it was seen; 'connect' then opens the Connect panel. */
export function closeWelcome(next?: 'connect') {
  setOpen(false); // before the flag, which a first read of the state would see
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore quota */ }
  if (next === 'connect') requestOpenConnections();
}

// For tests: the store's state and its subscription (which wires up the event).
export const welcomeStore = {
  isOpen, subscribe,
  reset() { openNow = null; },
};

// --- The dialog -----------------------------------------------------------------

const HELP_ID = 'welcome-help';

interface DialogProps {
  helpOpen: boolean;
  onToggleHelp: () => void;
  onConnect: () => void;
  onClose: () => void;
  dialogRef?: Ref<HTMLDivElement>;
}

// Markup only, no hooks, so tests can render it and press its buttons.
export function WelcomeDialog({ helpOpen, onToggleHelp, onConnect, onClose, dialogRef }: DialogProps) {
  return (
    <div className="wel-overlay" onClick={onClose}>
      <div className="wel-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true"
        aria-labelledby="welcome-title" ref={dialogRef} tabIndex={-1}>
        <div>
          <h2 id="welcome-title" className="wel-title">Welcome to KevFin</h2>
          <p className="wel-sub">Your accounts, investments, home and spending in one private place.</p>
        </div>

        {/* A real order: the other tabs stay empty until an account is in. */}
        <ol className="wel-steps">
          <li>
            <b>Connect your accounts</b>
            <p>On the Dashboard, click <span className="wel-ui">+ Connect</span> in Accounts,
              then <span className="wel-ui">+ Plaid</span> or <span className="wel-ui">+ SimpleFIN</span>.
              No connection? Import a CSV from Setup.</p>
          </li>
          <li>
            <b>Add your home and anything else</b>
            <p>Type your home's address in Real estate, then add its mortgage from the
              home's <span className="wel-ui">⋯</span> menu. Use Manual assets for anything a bank can't report.</p>
          </li>
          <li>
            <b>Look around</b>
            <p>Investments shows what your funds hold and what they cost. Budget shows where
              your money goes. Forecast shows whether it will last.</p>
          </li>
        </ol>

        <div className="wel-privacy">
          <span aria-hidden="true">🔒</span>
          <p>
            <strong>Stored only on your own computer.</strong> Look-ups send a ticker, a fund's
            security code, a shop's web address (for its logo) or your home's address, never your
            balances. The optional AI assistant is the one feature that sends your figures out, to
            Anthropic, and only when you use it.
          </p>
        </div>

        <div className="wel-actions">
          <button type="button" className="btn-primary wel-go" onClick={onConnect}>Connect an account</button>
          <button type="button" className="btn-ghost" onClick={onClose}>Look around first</button>
        </div>

        <button type="button" className="wel-fold" onClick={onToggleHelp}
          aria-expanded={helpOpen} aria-controls={HELP_ID}>
          What does each step need?
        </button>
        <div id={HELP_ID} className="wel-help" hidden={!helpOpen}>
          {helpOpen && (
            <dl>
              <div>
                <dt>Plaid · free developer account</dt>
                <dd>Sign up with Plaid and ask for production access (real bank data, allowed for
                  personal use). Copy your Client ID and Secret, then click + Plaid, paste both,
                  choose Save keys and pick your bank.{' '}
                  <a href="https://dashboard.plaid.com/developers/keys" target="_blank" rel="noreferrer">Get your Plaid keys →</a></dd>
              </div>
              <div>
                <dt>SimpleFIN · small subscription</dt>
                <dd>Link your banks at SimpleFIN Bridge and create a setup token there, then click
                  + SimpleFIN, paste the token and choose Connect.{' '}
                  <a href="https://beta-bridge.simplefin.org/my-account" target="_blank" rel="noreferrer">Get a SimpleFIN setup token →</a></dd>
              </div>
              <div>
                <dt>Neither</dt>
                <dd>In Setup, choose Import transactions from a CSV for your spending, and type
                  balances in under Manual assets.</dd>
              </div>
              <div>
                <dt>Home values</dt>
                <dd>A home's value only fills in by itself once you add a property-value key
                  (Add a key → under the address box). Without one, type it in with the ✎ pencil.</dd>
              </div>
              <div>
                <dt>AI assistant · optional</dt>
                <dd>It runs on your own Claude subscription, with no API key. Click the chat button
                  at the bottom right; if Claude isn't signed in yet, it shows how to turn it on. Setup
                  can switch it off.</dd>
              </div>
            </dl>
          )}
        </div>

        <p className="wel-foot">Reopen this from the ⚙ gear (Setup → Welcome guide), where backups live too.</p>
      </div>
    </div>
  );
}

export default function Welcome() {
  const open = useSyncExternalStore(subscribe, isOpen, isOpen);
  const [helpOpen, setHelpOpen] = useState(false);
  // Focus into the dialog, Tab kept inside it, page behind held still, focus back on close.
  const dialogRef = useModalDialog(open);

  // Each opening starts with the help folded.
  useEffect(() => { if (open) setHelpOpen(false); }, [open]);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeWelcome(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return (
    <WelcomeDialog
      helpOpen={helpOpen}
      onToggleHelp={() => setHelpOpen(h => !h)}
      onConnect={() => closeWelcome('connect')}
      onClose={() => closeWelcome()}
      dialogRef={dialogRef}
    />
  );
}
