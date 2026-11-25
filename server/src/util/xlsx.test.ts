import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readFirstSheet, readZipEntries } from './xlsx.js';

// Build a tiny zip in memory (deflate or store), enough to exercise the reader.
function zip(files: Record<string, string>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = [], dirs: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = method === 8 ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(comp.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp); dirs.push(dir, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const dirBuf = Buffer.concat(dirs);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(dirBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, eocd]);
}

// Same layout as SPDR's daily holdings sheet: preamble rows, a header row,
// shared strings (one rich-text), numbers, and a gap column.
const SHARED = '<sst><si><t>Ticker Symbol:</t></si><si><t>SPY</t></si><si><t>Name</t></si><si><t>Ticker</t></si>' +
  '<si><t>Weight</t></si><si><r><t>APPLE </t></r><r><t>INC</t></r></si><si><t>AAPL</t></si><si><t>AT&amp;T INC</t></si><si><t>T</t></si></sst>';
const SHEET = '<worksheet><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
  '<row r="2"/>' +
  '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="s"><v>3</v></c><c r="D3" t="s"><v>4</v></c></row>' +
  '<row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4" t="s"><v>6</v></c><c r="D4"><v>8.151812</v></c></row>' +
  '<row r="5"><c r="A5" t="s"><v>7</v></c><c r="B5" t="s"><v>8</v></c><c r="D5"><v>1.0E-2</v></c></row>' +
  '<row r="6"><c r="A6" t="inlineStr"><is><t>CASH</t></is></c></row>' +
  '</sheetData></worksheet>';

describe('readFirstSheet', () => {
  it('reads shared, rich-text, inline and numeric cells into positional rows', () => {
    const rows = readFirstSheet(zip({ 'xl/sharedStrings.xml': SHARED, 'xl/worksheets/sheet1.xml': SHEET }));
    expect(rows[0]).toEqual(['Ticker Symbol:', 'SPY']);
    expect(rows[1]).toEqual([]);
    expect(rows[2]).toEqual(['Name', 'Ticker', '', 'Weight']);
    expect(rows[3]).toEqual(['APPLE INC', 'AAPL', '', '8.151812']);
    expect(rows[4]).toEqual(['AT&T INC', 'T', '', '1.0E-2']);
    expect(rows[5]).toEqual(['CASH']);
  });

  it('handles stored (uncompressed) entries', () => {
    const rows = readFirstSheet(zip({ 'xl/sharedStrings.xml': SHARED, 'xl/worksheets/sheet1.xml': SHEET }, 0));
    expect(rows[3][1]).toBe('AAPL');
  });

  it('rejects non-zip input (an HTML error page)', () => {
    expect(() => readFirstSheet(Buffer.from('<!DOCTYPE html><html>blocked</html>'))).toThrow(/zip/);
  });

  it('only inflates the entries asked for', () => {
    const entries = readZipEntries(zip({ 'a.txt': 'A', 'b.txt': 'B' }), n => n === 'b.txt');
    expect([...entries.keys()]).toEqual(['b.txt']);
    expect(entries.get('b.txt')!.toString()).toBe('B');
  });
});
