// Render the quarterly report to a file without the AI binary or network.
//   DB_PATH=$PWD/../data/demo.db KEVFIN_REPORT_NO_AI=1 npx tsx scripts/render-report.ts out.html [YYYY-MM-DD]
import { writeFileSync } from 'fs';
process.env.KEVFIN_REPORT_NO_AI = '1';
if (!process.env.DB_PATH) { console.error('Set DB_PATH (use a demo DB).'); process.exit(1); }
// Holdings providers are network-backed; fail them fast so the report renders offline.
globalThis.fetch = (() => Promise.reject(new Error('network disabled'))) as typeof fetch;
const { generateQuarterlyReport } = await import('../src/services/report.js');
const out = process.argv[2] ?? 'report.html';
const now = process.argv[3] ? new Date(process.argv[3] + 'T12:00:00Z') : new Date();
writeFileSync(out, await generateQuarterlyReport(now));
console.log('wrote', out);
