// Logos for common US banks, brokerages and card issuers. The images are bundled
// in client/public/institutions/ (fetched once, 64×64 PNG) so drawing the
// Accounts list never tells an outside service which institutions the user has.
// Anything not listed falls back to an initials tile.

// First match wins, so more specific names come before broader ones
// (Merrill before Bank of America, Morgan Stanley before anything "Morgan").
const LOGOS: { slug: string; match: RegExp }[] = [
  { slug: 'merrill', match: /\bmerrill\b/ },
  { slug: 'morganstanley', match: /\bmorgan stanley\b/ },
  { slug: 'chase', match: /\bchase\b|\bjp ?morgan\b/ },
  { slug: 'fidelity', match: /\bfidelity\b/ },
  { slug: 'vanguard', match: /\bvanguard\b/ },
  { slug: 'schwab', match: /\bschwab\b/ },
  { slug: 'ally', match: /\bally\b/ },
  { slug: 'bankofamerica', match: /\bbank of america\b|\bbofa\b/ },
  { slug: 'wellsfargo', match: /\bwells fargo\b/ },
  { slug: 'citi', match: /\bciti(bank|group|cards?)?\b/ },
  { slug: 'capitalone', match: /\bcapital ?(one|1)\b/ },
  { slug: 'amex', match: /\bamerican express\b|\bamex\b/ },
  { slug: 'discover', match: /\bdiscover\b/ },
  { slug: 'usbank', match: /\bu ?s bank\b|\busbank\b/ },
  { slug: 'pnc', match: /\bpnc\b/ },
  { slug: 'truist', match: /\btruist\b/ },
  { slug: 'tdbank', match: /\btd bank\b/ },
  { slug: 'etrade', match: /\be ?trade\b/ },
  { slug: 'robinhood', match: /\brobinhood\b/ },
  { slug: 'sofi', match: /\bsofi\b/ },
  { slug: 'wealthfront', match: /\bwealthfront\b/ },
  { slug: 'betterment', match: /\bbetterment\b/ },
  { slug: 'ibkr', match: /\binteractive brokers\b|\bibkr\b/ },
  { slug: 'webull', match: /\bwebull\b/ },
  { slug: 'm1', match: /\bm1\b/ },
  { slug: 'coinbase', match: /\bcoinbase\b/ },
  { slug: 'paypal', match: /\bpaypal\b/ },
  { slug: 'venmo', match: /\bvenmo\b/ },
  { slug: 'chime', match: /\bchime\b/ },
  { slug: 'usaa', match: /\busaa\b/ },
  { slug: 'navyfederal', match: /\bnavy federal\b/ },
  { slug: 'synchrony', match: /\bsynchrony\b/ },
  { slug: 'barclays', match: /\bbarclays\b/ },
  { slug: 'hsbc', match: /\bhsbc\b/ },
  { slug: 'fifththird', match: /\bfifth third\b|\b5 3 bank\b/ },
  { slug: 'apple', match: /\bapple\b/ },
  { slug: 'bilt', match: /\bbilt\b/ },
  { slug: 'frec', match: /\bfrec\b/ },
  { slug: 'treasurydirect', match: /\btreasury ?direct\b/ },
];

/** Lower-cased, punctuation turned to spaces: "E*TRADE" → "e trade", "U.S. Bank" → "u s bank". */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** URL of the bundled logo for an institution name, or null when there isn't one. */
export function institutionLogo(org: string): string | null {
  const n = normalize(org);
  if (!n) return null;
  const hit = LOGOS.find(l => l.match.test(n));
  return hit ? `/institutions/${hit.slug}.png` : null;
}

/** Every bundled slug, for the test that checks each one has an image. */
export const LOGO_SLUGS = LOGOS.map(l => l.slug);
