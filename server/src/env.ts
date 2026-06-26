import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables before anything else reads them. Imported first by
// index.ts (replacing `import 'dotenv/config'`) so the chosen keys file wins.
//
// KEVFIN_ENV_PATH lets the desktop app point the keys file at a user-chosen
// location (e.g. a Dropbox/NAS folder). It must match the path keys.ts writes to,
// so the same file is read at startup and updated when credentials change.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default: server/.env, resolved relative to the compiled dist/ location so it
// works under both tsx (src) and the built server.
export const ENV_PATH = process.env.KEVFIN_ENV_PATH ?? path.join(__dirname, '../.env');

dotenv.config({ path: ENV_PATH });
