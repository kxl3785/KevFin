import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '../../data/kevfin.db'));

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseVal(s: string): number {
  const m = s.replace(/[$,\s]/g, '').match(/^([\d.]+)([MK]?)$/i);
  if (!m) throw new Error('bad value: ' + s);
  let v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === 'M') v *= 1e6;
  else if (u === 'K') v *= 1e3;
  return Math.round(v);
}

// Each line: "Mon YYYY\t$Value"
function parse(raw: string): { date: string; value: number }[] {
  return raw.trim().split('\n').map(line => {
    const [label, val] = line.split('\t');
    const [mon, year] = label.trim().split(/\s+/);
    const mm = MONTHS[mon.slice(0, 3).toLowerCase()];
    if (!mm) throw new Error('bad month: ' + label);
    return { date: `${year}-${mm}-01`, value: parseVal(val) };
  });
}

const WORTHINGTON = `
Mar 2026\t$1M
Feb 2026\t$1M
Jan 2026\t$1M
Dec 2025\t$1M
Nov 2025\t$1M
Oct 2025\t$1.1M
Sep 2025\t$1M
Aug 2025\t$1M
Jul 2025\t$1M
Jun 2025\t$1M
May 2025\t$1M
Apr 2025\t$1M
Mar 2025\t$1M
Feb 2025\t$1M
Jan 2025\t$1M
Dec 2024\t$1M
Nov 2024\t$1.1M
Oct 2024\t$1M
Sep 2024\t$1M
Aug 2024\t$1M
Jul 2024\t$1M
Jun 2024\t$1M
May 2024\t$1.1M
Apr 2024\t$1.1M
Mar 2024\t$1.1M
Feb 2024\t$1M
Jan 2024\t$1M
Dec 2023\t$1M
Nov 2023\t$1M
Oct 2023\t$994.3K
Sep 2023\t$1M
Aug 2023\t$1M
Jul 2023\t$1M
Jun 2023\t$1M
May 2023\t$1M
Apr 2023\t$1M
Mar 2023\t$997.6K
Feb 2023\t$977.3K
Jan 2023\t$965.1K
Dec 2022\t$961.6K
Nov 2022\t$964.2K
Oct 2022\t$960.3K
Sep 2022\t$944.3K
Aug 2022\t$937.3K
Jul 2022\t$967.8K
Jun 2022\t$996.5K
May 2022\t$998.8K
Apr 2022\t$964.4K
Mar 2022\t$914.5K
Feb 2022\t$880.1K
Jan 2022\t$866.1K
Dec 2021\t$865.8K
Nov 2021\t$864.6K
Oct 2021\t$854.7K
Sep 2021\t$846K
Aug 2021\t$842.2K
Jul 2021\t$839.1K
Jun 2021\t$818.6K
May 2021\t$797.7K
Apr 2021\t$779.4K
Mar 2021\t$762.2K
Feb 2021\t$755.5K
Jan 2021\t$744.5K
Dec 2020\t$744.2K
Nov 2020\t$733.4K
Oct 2020\t$732.7K
Sep 2020\t$721.9K
Aug 2020\t$716.5K
Jul 2020\t$712.7K
Jun 2020\t$711.5K
May 2020\t$705.5K
Apr 2020\t$704K
Mar 2020\t$702.8K
Feb 2020\t$698.5K
Jan 2020\t$695.6K
Dec 2019\t$685.7K
Nov 2019\t$687.3K
Oct 2019\t$683.3K
Sep 2019\t$683.7K
Aug 2019\t$682.7K
Jul 2019\t$681.8K
Jun 2019\t$679.3K
May 2019\t$676.6K
Apr 2019\t$663.5K
Mar 2019\t$723.4K
Feb 2019\t$724.2K
Jan 2019\t$710.8K
Dec 2018\t$723.8K
Nov 2018\t$725.3K
Oct 2018\t$725.8K
Sep 2018\t$773.8K
Aug 2018\t$789.3K
Jul 2018\t$789K
Jun 2018\t$797.5K
May 2018\t$795.4K
Apr 2018\t$800.2K
Mar 2018\t$846.1K
Feb 2018\t$846.8K
Jan 2018\t$837.5K
Dec 2017\t$837.5K
Nov 2017\t$840.8K
Oct 2017\t$866.2K
Sep 2017\t$870.4K
Aug 2017\t$870.9K
Jul 2017\t$868.8K
Jun 2017\t$1.2M
May 2017\t$1.1M
Apr 2017\t$1.1M
Mar 2017\t$1.1M
Feb 2017\t$1.1M
Jan 2017\t$973.2K
Dec 2016\t$981.2K
Nov 2016\t$951.4K
Oct 2016\t$949.8K
Sep 2016\t$932.4K
Aug 2016\t$911.5K
Jul 2016\t$983.8K
Jun 2016\t$965.5K
`;

const BRYN_MAWR = `
Mar 2026\t$2.9M
Feb 2026\t$2.9M
Jan 2026\t$2.8M
Dec 2025\t$2.9M
Nov 2025\t$2.9M
Oct 2025\t$2.9M
Sep 2025\t$2.9M
Aug 2025\t$2.9M
Jul 2025\t$2.9M
Jun 2025\t$2.9M
May 2025\t$3M
Apr 2025\t$2.9M
Mar 2025\t$2.9M
Feb 2025\t$2.8M
Jan 2025\t$2.7M
Dec 2024\t$2.7M
Nov 2024\t$2.7M
Oct 2024\t$2.6M
Sep 2024\t$2.6M
Aug 2024\t$2.7M
Jul 2024\t$2.7M
Jun 2024\t$2.7M
May 2024\t$2.7M
Apr 2024\t$2.7M
Mar 2024\t$2.7M
Feb 2024\t$2.7M
Jan 2024\t$2.7M
Dec 2023\t$2.6M
Nov 2023\t$2.7M
Oct 2023\t$2.7M
Sep 2023\t$2.6M
Aug 2023\t$2.6M
Jul 2023\t$2.6M
Jun 2023\t$2.6M
May 2023\t$2.8M
Apr 2023\t$2.4M
Mar 2023\t$2.4M
Feb 2023\t$2.4M
Jan 2023\t$2.4M
Dec 2022\t$2.4M
Nov 2022\t$2.4M
Oct 2022\t$2.4M
Sep 2022\t$2.4M
Aug 2022\t$2.5M
Jul 2022\t$2.5M
Jun 2022\t$2.6M
May 2022\t$2.6M
Apr 2022\t$2.5M
Mar 2022\t$2.4M
Feb 2022\t$2.3M
Jan 2022\t$2.2M
Dec 2021\t$2.2M
Nov 2021\t$2.1M
Oct 2021\t$2.1M
Sep 2021\t$2.1M
Aug 2021\t$2.1M
Jul 2021\t$2.1M
Jun 2021\t$2.1M
May 2021\t$2.1M
Apr 2021\t$2.1M
Mar 2021\t$2M
Feb 2021\t$1.9M
Jan 2021\t$1.9M
Dec 2020\t$1.9M
Nov 2020\t$1.9M
Oct 2020\t$1.9M
Sep 2020\t$1.9M
Aug 2020\t$1.9M
Jul 2020\t$1.9M
Jun 2020\t$1.9M
May 2020\t$1.9M
Apr 2020\t$1.9M
Mar 2020\t$1.9M
Feb 2020\t$1.9M
Jan 2020\t$1.8M
Dec 2019\t$1.8M
Nov 2019\t$1.8M
Oct 2019\t$1.8M
Sep 2019\t$1.8M
Aug 2019\t$1.8M
Jul 2019\t$1.8M
Jun 2019\t$1.8M
May 2019\t$1.8M
Apr 2019\t$1.8M
Mar 2019\t$1.8M
Feb 2019\t$1.8M
Jan 2019\t$1.8M
Dec 2018\t$1.8M
Nov 2018\t$1.8M
Oct 2018\t$1.8M
Sep 2018\t$1.8M
Aug 2018\t$1.8M
Jul 2018\t$1.8M
Jun 2018\t$1.8M
May 2018\t$1.7M
Apr 2018\t$1.7M
Mar 2018\t$1.7M
Feb 2018\t$1.7M
Jan 2018\t$1.7M
Dec 2017\t$1.7M
Nov 2017\t$1.7M
Oct 2017\t$1.7M
Sep 2017\t$1.7M
Aug 2017\t$1.7M
Jul 2017\t$1.6M
Jun 2017\t$1.6M
May 2017\t$1.6M
Apr 2017\t$1.6M
Mar 2017\t$1.9M
Feb 2017\t$1.9M
Jan 2017\t$1.9M
Dec 2016\t$1.9M
Nov 2016\t$1.9M
Oct 2016\t$1.9M
Sep 2016\t$1.9M
Aug 2016\t$1.8M
Jul 2016\t$1.8M
Jun 2016\t$1.8M
`;

function findId(like: string): number {
  const row = db.prepare('SELECT id FROM properties WHERE address LIKE ?').get(`%${like}%`) as { id: number } | undefined;
  if (!row) throw new Error('property not found: ' + like);
  return row.id;
}

const insert = db.prepare('INSERT OR REPLACE INTO property_value_history (property_id, date, value) VALUES (?, ?, ?)');

for (const [like, raw] of [['Worthington', WORTHINGTON], ['Bryn Mawr', BRYN_MAWR]] as const) {
  const id = findId(like);
  const points = parse(raw);
  db.prepare('DELETE FROM property_value_history WHERE property_id = ?').run(id);
  const tx = db.transaction(() => { for (const p of points) insert.run(id, p.date, p.value); });
  tx();
  console.log(`${like} (id ${id}): ${points.length} points, ${points[points.length - 1].date} → ${points[0].date}, latest=$${points[0].value.toLocaleString()}`);
}
