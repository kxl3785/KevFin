// Bridge exposed by the Electron preload (desktop/preload.js) when KevFin runs as
// the desktop app. Absent in the browser / NAS build — its presence is how the
// client detects the desktop context.
export {};

declare global {
  interface Window {
    kevfinDesktop?: {
      getPaths: () => Promise<{ dbPath: string; keysPath: string; port: number }>;
      chooseDir: (which: 'db' | 'keys') => Promise<string | null>;
      applyAndRelaunch: (next: { dbDir?: string; keysDir?: string }) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}
