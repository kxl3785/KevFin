import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { HELP_DOCS } from '../generated/helpDocs.js';
import { getSystemStatus } from './data.js';
import { getKeyStatus } from './keys.js';

// Lets the in-app assistant help with installing, updating and setting up KevFin
// itself, not just with the user's finances. Two things are put in its private
// temp dir each turn, beside the data files:
//   - help/…            the project's own guides, bundled at build time
//                       (generated/helpDocs.ts, from README.md and friends)
//   - setup_status.json what this installation looks like right now
// It still only has the Read tool: it explains the steps, the user carries them
// out. Nothing here is a secret — the status holds yes/no flags, never a key.

export const HELP_DIR = 'help';
export const SETUP_STATUS_FILE = 'setup_status.json';

export type RunMode = 'desktop app' | 'Docker container' | 'from source';

// How this copy is running, which decides which guide applies. A container has
// /.dockerenv; the desktop shell runs the server on Electron's own Node
// (ELECTRON_RUN_AS_NODE, desktop/main.js). KEVFIN_ENV_PATH is no use here: the
// compose files set it too.
export function runMode(env: NodeJS.ProcessEnv = process.env, inContainer = existsSync('/.dockerenv')): RunMode {
  if (inContainer) return 'Docker container';
  return env.ELECTRON_RUN_AS_NODE ? 'desktop app' : 'from source';
}

export interface AssistantInfo { binaryFound: boolean; loggedIn: boolean | null; model: string; minClaudeCodeVersion: string }

// A plain description of this installation for the assistant to reason over.
// Flags and counts only: no key, token, masked hint or email address.
export function buildSetupStatus(assistant: AssistantInfo): Record<string, unknown> {
  const sys = getSystemStatus();
  const keys = getKeyStatus();
  const hosts = (process.env.KEVFIN_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean);
  return {
    version: sys.version,
    runningAs: runMode(),
    operatingSystem: process.platform,
    port: Number(process.env.PORT) || 3001,
    databasePath: sys.dbPath,
    dailySnapshot: sys.dailySnapshotEnabled,
    lastSync: sys.lastSync,
    // Rows per table: zero connections or accounts means nothing is linked yet.
    rowCounts: sys.counts,
    configured: {
      plaidKeys: keys.plaid.set,
      plaidEnvironment: keys.plaid.set ? keys.plaid.env : null,
      propertyValueKeys: { openWebNinja: keys.openwebninja.set, apillow: keys.apillow.set },
      secContactEmail: Boolean(keys.sec.email),
    },
    extraAllowedHostnames: hosts,
    assistant: {
      claudeCodeFound: assistant.binaryFound,
      // null = not checked yet this run; this very answer proves it works.
      loggedIn: assistant.loggedIn,
      model: assistant.model,
      minimumClaudeCodeVersion: assistant.minClaudeCodeVersion,
    },
  };
}

// Write the guides and the status file into the chat's temp dir; returns the
// entries for the prompt's file list. Best-effort per file.
export function writeSetupHelp(dir: string, assistant: AssistantInfo): { name: string; desc: string }[] {
  const files: { name: string; desc: string }[] = [];
  try {
    mkdirSync(path.join(dir, HELP_DIR), { recursive: true });
    for (const d of HELP_DOCS) {
      const name = `${HELP_DIR}/${d.file}`;
      try {
        writeFileSync(path.join(dir, name), d.text, { mode: 0o600 });
        files.push({ name, desc: `KevFin guide. ${d.desc}` });
      } catch (e) { console.error(`[assistant] help ${d.file} failed:`, e); }
    }
  } catch (e) { console.error('[assistant] help dir failed:', e); }
  try {
    writeFileSync(path.join(dir, SETUP_STATUS_FILE), JSON.stringify(buildSetupStatus(assistant), null, 2), { mode: 0o600 });
    files.push({
      name: SETUP_STATUS_FILE,
      desc: 'This installation right now: version, how it is running (desktop app, Docker container or from source), ' +
        'what is connected and configured (yes/no only), last sync times, and the assistant\'s own status.',
    });
  } catch (e) { console.error('[assistant] setup status failed:', e); }
  return files;
}

// The prompt section. Kept short: the guides themselves are read on demand.
export function setupInstructions(): string {
  return (
    `# Installing and setting up KevFin\n\n` +
    `Besides their finances, the user can ask you about KevFin itself: installing ` +
    `it (desktop app, Docker, a Synology NAS, from source), updating, connecting ` +
    `accounts with SimpleFIN or Plaid, adding a home, using it from a phone, ` +
    `backups and restores, moving to another computer, and getting this ` +
    `assistant's Claude sign-in working.\n` +
    `- The project's own guides are in the ${HELP_DIR}/ folder (see the file ` +
    `list). Read the relevant guide before answering and follow it: give ` +
    `commands, file names, menu names and settings exactly as written there. ` +
    `They were bundled with this version of KevFin. If the guides do not cover ` +
    `what is asked, say so plainly instead of guessing, and point to the ` +
    `project's issue tracker named in the guides.\n` +
    `- ${SETUP_STATUS_FILE} describes this installation. Read it when the ` +
    `question is "what do I still need to set up", "why isn't this working" or ` +
    `anything that depends on how this copy runs, and tailor the steps to it ` +
    `(Docker steps for a container, the installer for the desktop app). Say what ` +
    `is already done so they do not repeat it.\n` +
    `- You cannot run commands, edit files or change settings. Give the steps for ` +
    `the user to carry out: numbered, one action per step, saying where each ` +
    `happens (most are in Setup, the gear button at the top of the app).\n` +
    `- Never ask the user to paste a password, setup token, access token or API ` +
    `key into this chat, and do not repeat one back if they do. Those go into ` +
    `the Setup screens or the keys file, as the guides describe.\n` +
    `- For anything that deletes data (restore from backup, erase, reinstalling ` +
    `over a data folder), tell them to download a backup first.`
  );
}
