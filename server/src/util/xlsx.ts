// Minimal reader for the first worksheet of an .xlsx file, as rows of cell
// strings. Enough for the plain holdings spreadsheets fund companies publish
// (SPDR's daily holdings): no formulas, styles, dates or multiple sheets.
//
// An .xlsx is a zip of XML parts. This reads the zip's central directory,
// inflates the two parts that matter (xl/sharedStrings.xml and the first sheet)
// with node's zlib, and pulls cell values out with regexes. Dependency-free on
// purpose: one fund-company spreadsheet isn't worth a full Office library.
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY_BYTES = 30 * 1024 * 1024; // refuse zip bombs / absurd sheets

// name -> uncompressed bytes, for the entries `want` accepts.
export function readZipEntries(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End-of-central-directory record: signature 0x06054b50, within the last 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (size > MAX_ENTRY_BYTES) throw new Error(`zip entry too large: ${name}`);
    // Local header: its own name/extra lengths can differ from the directory's.
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
    else throw new Error(`unsupported zip compression ${method}`);
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// "AB" -> 27 (1-based column number).
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** The first worksheet as rows of trimmed strings (missing cells are ''). */
export function readFirstSheet(buf: Buffer): string[][] {
  const parts = readZipEntries(buf, n => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet1\.xml$/.test(n));
  const sheet = parts.get('xl/worksheets/sheet1.xml')?.toString('utf8');
  if (!sheet) throw new Error('no first worksheet');
  const shared = [...(parts.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    // Rich-text strings split into several <t> runs; join them.
    .map(m => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const rows: string[][] = [];
  // Empty rows can be self-closing (<row r="2"/>).
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = [];
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const body = cm[2] ?? '';
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      let value = '';
      if (type === 'inlineStr') value = decode([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));
      else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
        value = type === 's' ? shared[Number(v)] ?? '' : decode(v);
      }
      const col = ref ? colIndex(ref) - 1 : row.length;
      while (row.length < col) row.push('');
      row[col] = value.trim();
    }
    rows.push(row);
  }
  return rows;
}
