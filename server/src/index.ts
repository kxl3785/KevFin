import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import simplefinRoutes from './routes/simplefin.js';
import plaidRoutes from './routes/plaid.js';
import propertyRoutes from './routes/properties.js';
import assetRoutes from './routes/assets.js';
import allocationRoutes from './routes/allocation.js';
import budgetRoutes from './routes/budget.js';
import netWorthRoutes from './routes/netWorth.js';
import recurringRoutes from './routes/recurring.js';
import performanceRoutes from './routes/performance.js';
import assistantRoutes from './routes/assistant.js';
import metaRoutes from './routes/meta.js';
import {
  refreshAccountsAndSnapshot,
  refreshRealEstateAndSnapshot,
  catchUpRealEstate,
} from './services/netWorth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // allow large CSV transaction uploads

app.use('/api/simplefin', simplefinRoutes);
app.use('/api/plaid', plaidRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/allocation', allocationRoutes);
app.use('/api/budget', budgetRoutes);
app.use('/api/net-worth', netWorthRoutes);
app.use('/api/recurring', recurringRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/meta', metaRoutes);

// Accounts/brokerages: refresh daily at 6 AM
cron.schedule('0 6 * * *', async () => {
  console.log('[cron] Daily accounts refresh...');
  await refreshAccountsAndSnapshot();
});

// Real estate: refresh twice a month — 1st and 15th at 6:30 AM
cron.schedule('30 6 1,15 * *', async () => {
  console.log('[cron] Twice-monthly real estate refresh...');
  await refreshRealEstateAndSnapshot();
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`KevFin server running on http://localhost:${PORT}`);
  // Catch up on real estate if a scheduled run was missed while offline.
  catchUpRealEstate().catch(err => console.error('[startup] catch-up failed:', err));
});
