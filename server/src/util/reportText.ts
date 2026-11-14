// Plain text of the quarterly report page, for the AI assistant to read.
//
// The report is stored as one self-contained HTML page (services/reportCache.ts).
// When the user has it open and asks the assistant about it, the chat gets the
// same report as a text file — so the assistant answers from the figures the user
// is looking at rather than recomputing its own. Pure string work, no DOM and no
// dependencies. It only has to be readable, not a faithful layout.

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  minus: '−', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', times: '×',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // Skip anything that is not a real, printable code point.
      return Number.isFinite(code) && code >= 0x20 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

// Tags that end a line of text.
const BLOCK = /<\/?(?:p|div|section|article|header|footer|main|h[1-6]|ul|ol|li|table|thead|tbody|tr|br|hr|figure|figcaption|blockquote|dl|dt|dd)\b[^>]*>/gi;

/**
 * Reduce a report page to readable text: scripts and styles are dropped, each
 * chart is replaced by the description it carries (the report's SVG charts have
 * an aria-label spelling out their values), table cells are separated, and
 * everything else loses its tags. Capped at `maxChars`.
 */
export function reportHtmlToText(html: string, maxChars = 120_000): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    // A chart becomes its own description; an undescribed SVG (an icon) is dropped.
    .replace(/<svg\b([^>]*)>[\s\S]*?<\/svg\s*>/gi, (_m, attrs: string) => {
      const label = /\baria-label="([^"]*)"/i.exec(attrs)?.[1];
      return label ? `\n[Chart: ${label}]\n` : '';
    })
    .replace(/<\/(?:td|th)\s*>/gi, ' | ')
    .replace(BLOCK, '\n')
    // Side-by-side inline elements (a label span next to its amount span) would
    // otherwise run together as "Groceries$861" once the tags are gone. Same
    // line only: the line breaks the block tags just became must survive.
    .replace(/<\/[a-z][a-z0-9]*\s*>[ \t]*<(?!\/)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n').map(line => line.trim().replace(/ \|$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > maxChars ? s.slice(0, maxChars) + '\n[report text cut off here]' : s;
}
