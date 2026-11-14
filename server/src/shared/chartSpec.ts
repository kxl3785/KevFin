// The chart spec the AI assistant may include in a chat answer, and its validator.
//
// The assistant's sandbox gives the model no way to write files or run code, so
// it cannot produce a chart itself. Instead it emits a small declarative spec as
// TEXT (a fenced ```chart block holding one JSON object) and the client draws it
// with Recharts. That makes this validator the trust boundary: model output is
// untrusted (transaction memos and uploaded documents can reach the model), so
// nothing from a spec is used until it has passed validateChartSpec, which
// returns a freshly built object holding only the known fields — never the
// parsed input itself.
//
// Shared by both sides of the API boundary (like apiTypes.ts, via the client's
// `@shared` alias): the server quotes the limits in the chat system prompt, the
// client validates and renders. Unlike apiTypes.ts this module has runtime code,
// so it must stay dependency-free — no imports.

export const CHART_TYPES = ['line', 'area', 'bar', 'stacked_bar', 'pie', 'donut'] as const;
export type ChartType = typeof CHART_TYPES[number];

// How values are printed. `percent` values are already percentages (12.5 → "12.5%").
export const CHART_FORMATS = ['currency', 'percent', 'number'] as const;
export type ChartFormat = typeof CHART_FORMATS[number];

export interface ChartSeries {
  name: string;
  data: number[]; // one value per label, same order
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  format: ChartFormat;
  labels: string[];      // x-axis categories; slice names for pie / donut
  series: ChartSeries[]; // pie / donut take exactly one
}

// The info string of the fenced block the model writes the spec in.
export const CHART_FENCE = 'chart';

export const CHART_LIMITS = {
  maxSpecChars: 20_000, // raw JSON text of one spec
  maxSeries: 8,         // also the size of the series colour palette — never cycled
  maxPoints: 120,       // labels (so points per series)
  maxSlices: 8,         // pie / donut labels
  maxTitleChars: 120,
  maxLabelChars: 60,    // each label and each series name
} as const;

export type ChartSpecResult =
  | { ok: true; spec: ChartSpec }
  | { ok: false; error: string };

const fail = (error: string): ChartSpecResult => ({ ok: false, error });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const isPieType = (t: ChartType) => t === 'pie' || t === 'donut';

// A short display string: trimmed, non-empty, within `max`. Labels may also
// arrive as finite numbers (a model writes years as 2024, not "2024").
function text(v: unknown, max: number, allowNumber = false): string | null {
  if (allowNumber && typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

/**
 * Validate an already-parsed value as a chart spec. Strict about everything that
 * is drawn: unknown chart types and formats, non-finite or non-numeric points,
 * ragged series and anything over CHART_LIMITS are rejected outright rather than
 * repaired — a chart that silently differs from what the model wrote would be
 * worse than no chart. Unknown extra keys are ignored (they are simply not
 * copied into the result).
 */
export function validateChartSpec(input: unknown): ChartSpecResult {
  if (!isPlainObject(input)) return fail('spec must be a JSON object');

  const type = input.type;
  if (typeof type !== 'string' || !(CHART_TYPES as readonly string[]).includes(type)) {
    return fail(`type must be one of ${CHART_TYPES.join(', ')}`);
  }
  const chartType = type as ChartType;

  const title = text(input.title, CHART_LIMITS.maxTitleChars);
  if (title === null) return fail(`title must be a non-empty string of at most ${CHART_LIMITS.maxTitleChars} characters`);

  // format is optional (plain numbers), but a present-and-unknown one is an error.
  const rawFormat = input.format === undefined ? 'number' : input.format;
  if (typeof rawFormat !== 'string' || !(CHART_FORMATS as readonly string[]).includes(rawFormat)) {
    return fail(`format must be one of ${CHART_FORMATS.join(', ')}`);
  }
  const format = rawFormat as ChartFormat;

  if (!Array.isArray(input.labels) || input.labels.length === 0) return fail('labels must be a non-empty array');
  const maxLabels = isPieType(chartType) ? CHART_LIMITS.maxSlices : CHART_LIMITS.maxPoints;
  if (input.labels.length > maxLabels) return fail(`too many labels (max ${maxLabels} for ${chartType})`);
  const labels: string[] = [];
  for (const raw of input.labels) {
    const label = text(raw, CHART_LIMITS.maxLabelChars, true);
    if (label === null) return fail(`each label must be a non-empty string of at most ${CHART_LIMITS.maxLabelChars} characters`);
    labels.push(label);
  }

  if (!Array.isArray(input.series) || input.series.length === 0) return fail('series must be a non-empty array');
  if (isPieType(chartType) && input.series.length !== 1) return fail(`${chartType} takes exactly one series`);
  if (input.series.length > CHART_LIMITS.maxSeries) return fail(`too many series (max ${CHART_LIMITS.maxSeries})`);

  const series: ChartSeries[] = [];
  for (const raw of input.series) {
    if (!isPlainObject(raw)) return fail('each series must be an object');
    const name = text(raw.name, CHART_LIMITS.maxLabelChars);
    if (name === null) return fail(`each series needs a name of at most ${CHART_LIMITS.maxLabelChars} characters`);
    if (!Array.isArray(raw.data) || raw.data.length !== labels.length) {
      return fail(`series "${name}" must have exactly one value per label (${labels.length})`);
    }
    const data: number[] = [];
    for (const v of raw.data) {
      // typeof first: "12", null and true are not numbers. isFinite catches the
      // values JSON can still smuggle in as numbers (1e999 parses to Infinity).
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`series "${name}" has a value that is not a finite number`);
      data.push(v);
    }
    series.push({ name, data });
  }

  if (isPieType(chartType)) {
    const slices = series[0].data;
    if (slices.some(v => v < 0)) return fail(`${chartType} values cannot be negative`);
    if (!slices.some(v => v > 0)) return fail(`${chartType} needs at least one value above zero`);
  }

  return { ok: true, spec: { type: chartType, title, format, labels, series } };
}

/** Parse and validate the raw text of one spec (the body of a ```chart block). */
export function parseChartSpec(raw: string): ChartSpecResult {
  if (typeof raw !== 'string') return fail('spec must be text');
  if (raw.length > CHART_LIMITS.maxSpecChars) return fail(`spec is too large (max ${CHART_LIMITS.maxSpecChars} characters)`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail('spec is not valid JSON'); }
  return validateChartSpec(parsed);
}
