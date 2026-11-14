import { describe, it, expect } from 'vitest';
import { validateChartSpec, parseChartSpec, CHART_LIMITS, CHART_TYPES, type ChartSpec } from './chartSpec.js';

const line = (over: Record<string, unknown> = {}) => ({
  type: 'line',
  title: 'Net worth',
  format: 'currency',
  labels: ['Jan', 'Feb', 'Mar'],
  series: [{ name: 'Net worth', data: [100, 110, 125.5] }],
  ...over,
});

const expectOk = (input: unknown): ChartSpec => {
  const r = validateChartSpec(input);
  if (!r.ok) throw new Error(`expected a valid spec, got: ${r.error}`);
  return r.spec;
};
const expectFail = (input: unknown, match?: RegExp) => {
  const r = validateChartSpec(input);
  expect(r.ok).toBe(false);
  if (!r.ok && match) expect(r.error).toMatch(match);
};

describe('validateChartSpec — accepts', () => {
  it('a minimal line chart', () => {
    expect(expectOk(line())).toEqual(line());
  });

  it('every documented chart type', () => {
    for (const type of CHART_TYPES) {
      const spec = expectOk(line({ type }));
      expect(spec.type).toBe(type);
    }
  });

  it('defaults format to number when omitted', () => {
    const { format: _omit, ...noFormat } = line();
    expect(expectOk(noFormat).format).toBe('number');
  });

  it('negative and zero values on cartesian charts', () => {
    expectOk(line({ type: 'bar', series: [{ name: 'Net', data: [-50, 0, 20] }] }));
    expectOk(line({ type: 'stacked_bar', series: [{ name: 'In', data: [5, 6, 7] }, { name: 'Out', data: [-3, -4, -5] }] }));
  });

  it('numeric labels (years) and trims text', () => {
    const spec = expectOk(line({ title: '  Spending  ', labels: [2023, 2024, ' 2025 '], series: [{ name: ' Total ', data: [1, 2, 3] }] }));
    expect(spec.title).toBe('Spending');
    expect(spec.labels).toEqual(['2023', '2024', '2025']);
    expect(spec.series[0].name).toBe('Total');
  });

  it('exactly the series and point caps', () => {
    const labels = Array.from({ length: CHART_LIMITS.maxPoints }, (_, i) => `d${i}`);
    const series = Array.from({ length: CHART_LIMITS.maxSeries }, (_, s) => ({ name: `s${s}`, data: labels.map((_, i) => i + s) }));
    const spec = expectOk(line({ labels, series }));
    expect(spec.series).toHaveLength(CHART_LIMITS.maxSeries);
    expect(spec.labels).toHaveLength(CHART_LIMITS.maxPoints);
  });

  it('returns a fresh object holding only the known fields', () => {
    const input = line({ onClick: 'alert(1)', html: '<img src=x>', series: [{ name: 'A', data: [1, 2, 3], color: 'url(https://example.com/x)' }] });
    const spec = expectOk(input);
    expect(Object.keys(spec).sort()).toEqual(['format', 'labels', 'series', 'title', 'type']);
    expect(Object.keys(spec.series[0]).sort()).toEqual(['data', 'name']);
    expect(spec.series).not.toBe(input.series);
    expect(spec.series[0].data).not.toBe((input.series as { data: number[] }[])[0].data);
  });

  it('keeps awkward names as plain strings', () => {
    const spec = expectOk(line({ series: [{ name: '__proto__', data: [1, 2, 3] }, { name: 'constructor', data: [1, 2, 3] }] }));
    expect(spec.series.map(s => s.name)).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).data).toBeUndefined(); // nothing leaked onto Object.prototype
  });
});

describe('validateChartSpec — rejects', () => {
  it('non-objects', () => {
    for (const v of [null, undefined, 'line', 42, [], [line()]]) expectFail(v, /JSON object/);
  });

  it('unknown or missing chart types', () => {
    for (const type of ['scatter', 'radar', 'Line', 'html', '', undefined, 3, ['line']]) expectFail(line({ type }), /type must be/);
  });

  it('unknown formats', () => {
    for (const format of ['usd', 'money', '', null, 1]) expectFail(line({ format }), /format must be/);
  });

  it('bad titles', () => {
    for (const title of [undefined, '', '   ', 7, 'x'.repeat(CHART_LIMITS.maxTitleChars + 1)]) expectFail(line({ title }), /title/);
  });

  it('bad labels', () => {
    expectFail(line({ labels: [] }), /labels/);
    expectFail(line({ labels: 'Jan,Feb,Mar' }), /labels/);
    expectFail(line({ labels: ['Jan', '', 'Mar'] }), /label/);
    expectFail(line({ labels: ['Jan', null, 'Mar'] }), /label/);
    expectFail(line({ labels: ['Jan', { toString: () => 'Feb' }, 'Mar'] }), /label/);
    expectFail(line({ labels: ['Jan', 'x'.repeat(CHART_LIMITS.maxLabelChars + 1), 'Mar'] }), /label/);
    expectFail(line({ labels: [1, Infinity, 3] }), /label/);
  });

  it('non-finite and non-numeric points', () => {
    for (const bad of [NaN, Infinity, -Infinity, '110', null, undefined, true, [110], {}]) {
      expectFail(line({ series: [{ name: 'A', data: [100, bad, 125] }] }), /finite number/);
    }
  });

  it('ragged series', () => {
    expectFail(line({ series: [{ name: 'A', data: [1, 2] }] }), /one value per label/);
    expectFail(line({ series: [{ name: 'A', data: [1, 2, 3, 4] }] }), /one value per label/);
    expectFail(line({ series: [{ name: 'A', data: [1, 2, 3] }, { name: 'B', data: [1, 2] }] }), /one value per label/);
    expectFail(line({ series: [{ name: 'A', data: '1,2,3' }] }), /one value per label/);
  });

  it('malformed series', () => {
    expectFail(line({ series: [] }), /series/);
    expectFail(line({ series: {} }), /series/);
    expectFail(line({ series: [[1, 2, 3]] }), /series must be an object/);
    expectFail(line({ series: [{ data: [1, 2, 3] }] }), /name/);
    expectFail(line({ series: [{ name: '', data: [1, 2, 3] }] }), /name/);
    expectFail(line({ series: [{ name: 'x'.repeat(CHART_LIMITS.maxLabelChars + 1), data: [1, 2, 3] }] }), /name/);
  });

  it('more series than the cap', () => {
    const series = Array.from({ length: CHART_LIMITS.maxSeries + 1 }, (_, s) => ({ name: `s${s}`, data: [1, 2, 3] }));
    expectFail(line({ series }), /too many series/);
  });

  it('more points than the cap', () => {
    const labels = Array.from({ length: CHART_LIMITS.maxPoints + 1 }, (_, i) => `d${i}`);
    expectFail(line({ labels, series: [{ name: 'A', data: labels.map(() => 1) }] }), /too many labels/);
  });
});

describe('validateChartSpec — pie and donut', () => {
  const pie = (over: Record<string, unknown> = {}) => ({
    type: 'pie', title: 'Allocation', format: 'percent',
    labels: ['Stocks', 'Bonds', 'Cash'],
    series: [{ name: 'Share', data: [70, 20, 10] }],
    ...over,
  });

  it('accepts one non-negative series', () => {
    expectOk(pie());
    expectOk(pie({ type: 'donut', series: [{ name: 'Share', data: [70, 0, 30] }] }));
  });

  it('rejects more than one series', () => {
    expectFail(pie({ series: [{ name: 'A', data: [1, 2, 3] }, { name: 'B', data: [1, 2, 3] }] }), /exactly one series/);
  });

  it('rejects negative slices and an all-zero pie', () => {
    expectFail(pie({ series: [{ name: 'Share', data: [70, -20, 10] }] }), /negative/);
    expectFail(pie({ series: [{ name: 'Share', data: [0, 0, 0] }] }), /above zero/);
  });

  it('caps slices lower than cartesian points', () => {
    const labels = Array.from({ length: CHART_LIMITS.maxSlices + 1 }, (_, i) => `slice ${i}`);
    expectFail(pie({ labels, series: [{ name: 'Share', data: labels.map(() => 1) }] }), /too many labels/);
    expectOk(line({ labels, series: [{ name: 'A', data: labels.map(() => 1) }] })); // fine as a line chart
  });
});

describe('parseChartSpec', () => {
  it('parses valid JSON text', () => {
    const r = parseChartSpec(JSON.stringify(line()));
    expect(r).toEqual({ ok: true, spec: line() });
  });

  it('rejects text that is not JSON', () => {
    for (const raw of ['', 'not json', '{"type":"line",', "{'type':'line'}", '{"type":"line",} // trailing']) {
      const r = parseChartSpec(raw);
      expect(r).toEqual({ ok: false, error: 'spec is not valid JSON' });
    }
  });

  it('rejects numbers JSON parses to Infinity', () => {
    const raw = JSON.stringify(line()).replace('110', '1e999');
    const r = parseChartSpec(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/finite number/);
  });

  it('rejects an oversized payload before parsing it', () => {
    const big = JSON.stringify(line({ note: 'x'.repeat(CHART_LIMITS.maxSpecChars) }));
    const r = parseChartSpec(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/);
    // The same spec without the padding is fine — size alone was the problem.
    expect(parseChartSpec(JSON.stringify(line())).ok).toBe(true);
  });

  it('rejects non-string input', () => {
    expect(parseChartSpec(undefined as unknown as string).ok).toBe(false);
  });

  it('does not let a __proto__ key through as a spec field', () => {
    const r = parseChartSpec('{"__proto__":{"type":"line"},"title":"T","labels":["a"],"series":[{"name":"A","data":[1]}]}');
    expect(r.ok).toBe(false); // type must be an own, valid field
  });
});
