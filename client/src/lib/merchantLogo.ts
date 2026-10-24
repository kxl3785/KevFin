// Maps a transaction payee/merchant string to a brand domain, so we can show a
// real favicon/logo via free icon services (see logoCandidates below).
// Unknown merchants fall back to a letter avatar (see MerchantIcon).
//
// Entries are matched as whole words against a normalised merchant string
// (lowercased, punctuation collapsed to spaces, so keys are written in that form:
// "t mobile", not "t-mobile"). Order matters: more specific keys first. A brand that
// appears run together or with a suffix in card descriptors ("mcdonalds", "united
// airlines") needs its own variant, since a bare substring would also hit
// "purchase" for "chase" or "neighborhood" for "hbo".

const DOMAINS: [string, string][] = [
  // Grocery
  ['whole foods', 'wholefoodsmarket.com'],
  ['wholefoods', 'wholefoodsmarket.com'],
  ['trader joe', 'traderjoes.com'],
  ['trader joes', 'traderjoes.com'],
  ['safeway', 'safeway.com'],
  ['kroger', 'kroger.com'],
  ['costco', 'costco.com'],
  ['walmart', 'walmart.com'],
  ['aldi', 'aldi.us'],
  ['publix', 'publix.com'],
  ['wegmans', 'wegmans.com'],
  ['sprouts', 'sprouts.com'],
  ['mitsuwa', 'mitsuwa.com'],
  ['h mart', 'hmart.com'],
  ['heb', 'heb.com'],
  ['instacart', 'instacart.com'],
  // Dining / fast food / coffee
  ['chick fil a', 'chick-fil-a.com'],
  ['chickfila', 'chick-fil-a.com'],
  ['starbucks', 'starbucks.com'],
  ['mcdonald', 'mcdonalds.com'],
  ['mcdonalds', 'mcdonalds.com'],
  ['chipotle', 'chipotle.com'],
  ['panera', 'panerabread.com'],
  ['dunkin', 'dunkindonuts.com'],
  ['dunkindonuts', 'dunkindonuts.com'],
  ['wendy', 'wendys.com'],
  ['wendys', 'wendys.com'],
  ['taco bell', 'tacobell.com'],
  ['tacobell', 'tacobell.com'],
  ['burger king', 'bk.com'],
  ['burgerking', 'bk.com'],
  ['subway', 'subway.com'],
  ['popeyes', 'popeyes.com'],
  ['shake shack', 'shakeshack.com'],
  ['five guys', 'fiveguys.com'],
  ['doordash', 'doordash.com'],
  ['uber eats', 'ubereats.com'],
  ['ubereats', 'ubereats.com'],
  ['grubhub', 'grubhub.com'],
  // Transport / gas
  ['quiktrip', 'quiktrip.com'],
  ['shell', 'shell.com'],
  ['chevron', 'chevron.com'],
  ['exxon', 'exxon.com'],
  ['exxonmobil', 'exxon.com'],
  ['mobil', 'exxon.com'],
  ['bp', 'bp.com'],
  ['76', 'union76.com'],
  ['arco', 'arco.com'],
  ['uber', 'uber.com'],
  ['lyft', 'lyft.com'],
  ['amtrak', 'amtrak.com'],
  ['delta', 'delta.com'],
  ['united airlines', 'united.com'],
  ['united air', 'united.com'],
  ['southwest', 'southwest.com'],
  ['american airlines', 'aa.com'],
  ['hertz', 'hertz.com'],
  ['enterprise rent', 'enterprise.com'],
  // Shopping / retail
  ['amazon', 'amazon.com'],
  ['amzn', 'amazon.com'],
  ['best buy', 'bestbuy.com'],
  ['bestbuy', 'bestbuy.com'],
  ['newegg', 'newegg.com'],
  ['the home depot', 'homedepot.com'],
  ['home depot', 'homedepot.com'],
  ['homedepot', 'homedepot.com'],
  ['lowe', 'lowes.com'],
  ['lowes', 'lowes.com'],
  ['target', 'target.com'],
  ['nordstrom', 'nordstrom.com'],
  ['macy', 'macys.com'],
  ['macys', 'macys.com'],
  ['nike', 'nike.com'],
  ['etsy', 'etsy.com'],
  ['ebay', 'ebay.com'],
  ['ikea', 'ikea.com'],
  ['apple', 'apple.com'],
  ['walgreens', 'walgreens.com'],
  ['cvs', 'cvs.com'],
  // Subscriptions / tech / media
  ['anthropic', 'anthropic.com'],
  ['openai', 'openai.com'],
  ['netflix', 'netflix.com'],
  ['spotify', 'spotify.com'],
  ['hulu', 'hulu.com'],
  ['disney', 'disneyplus.com'],
  ['disneyplus', 'disneyplus.com'],
  ['youtube', 'youtube.com'],
  ['youtubepremium', 'youtube.com'],
  ['youtubetv', 'youtube.com'],
  ['hbo', 'hbomax.com'],
  ['hbomax', 'hbomax.com'],
  ['paramount', 'paramountplus.com'],
  ['patreon', 'patreon.com'],
  ['adobe', 'adobe.com'],
  ['microsoft', 'microsoft.com'],
  ['google', 'google.com'],
  ['icloud', 'apple.com'],
  ['steam', 'steampowered.com'],
  ['steamgames', 'steampowered.com'],
  ['playstation', 'playstation.com'],
  ['nintendo', 'nintendo.com'],
  ['peloton', 'onepeloton.com'],
  // Bills / utilities / telecom
  ['comcast', 'xfinity.com'],
  ['xfinity', 'xfinity.com'],
  ['at&t', 'att.com'],
  ['verizon', 'verizon.com'],
  ['t mobile', 't-mobile.com'],
  ['pg&e', 'pge.com'],
  ['terminix', 'terminix.com'],
  // Travel / lodging
  ['airbnb', 'airbnb.com'],
  ['marriott', 'marriott.com'],
  ['hilton', 'hilton.com'],
  ['expedia', 'expedia.com'],
  ['booking.com', 'booking.com'],
  // Finance / transfers
  ['chase', 'chase.com'],
  ['fidelity', 'fidelity.com'],
  ['robinhood', 'robinhood.com'],
  ['bilt', 'biltrewards.com'],
  ['greenlight', 'greenlight.com'],
  ['venmo', 'venmo.com'],
  ['zelle', 'zellepay.com'],
  ['paypal', 'paypal.com'],
  ['cash app', 'cash.app'],
  ['simplefin', 'simplefin.org'],
  ['health equity', 'healthequity.com'],
  ['healthequity', 'healthequity.com'],
  ['equinox', 'equinox.com'],
];

const NORM_RE = /[^a-z0-9& .]/g;

// Lowercase and strip noisy tokens that show up in card descriptors.
function normalise(s: string): string {
  return ` ${s.toLowerCase().replace(/\bdd \*|tst\*|sq \*|sp \*|paypal \*/g, ' ').replace(NORM_RE, ' ').replace(/\s+/g, ' ')} `;
}

// Whole-word test: the key must not be flanked by letters/digits, so "mobil"
// doesn't hit "t mobile", "chase" doesn't hit "purchase", and "76" doesn't hit
// "1769". Punctuation like the "." in "amazon.com" still counts as a boundary.
function hasWord(n: string, key: string): boolean {
  const isAlnum = (c: string | undefined) => !!c && /[a-z0-9]/.test(c);
  for (let i = n.indexOf(key); i !== -1; i = n.indexOf(key, i + 1)) {
    if (!isAlnum(n[i - 1]) && !isAlnum(n[i + key.length])) return true;
  }
  return false;
}

const cache = new Map<string, string | null>();

/** Resolve a merchant string to a brand domain, or null when unknown. */
export function merchantDomain(merchant: string): string | null {
  if (cache.has(merchant)) return cache.get(merchant)!;
  const n = normalise(merchant);
  let hit: string | null = null;
  for (const [key, domain] of DOMAINS) {
    if (hasWord(n, key)) { hit = domain; break; }
  }
  cache.set(merchant, hit);
  return hit;
}

// Ordered candidate icon URLs for a domain, most reliable first. DuckDuckGo and
// Google both serve favicons for any public domain with no API key (Clearbit's
// free logo API was sunset after the HubSpot acquisition and now returns blanks,
// so it's no longer used). MerchantIcon walks this list on each load error.
export function logoCandidates(domain: string): string[] {
  return [
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
  ];
}

// Deterministic pleasant color for a merchant's letter avatar.
const AVATAR_COLORS = ['#6c8fff', '#4ade80', '#fbbf24', '#f472b6', '#38bdf8', '#a78bfa', '#fb923c', '#34d399', '#f87171', '#c084fc', '#2dd4bf'];
export function avatarColor(merchant: string): string {
  let h = 0;
  for (let i = 0; i < merchant.length; i++) h = (h * 31 + merchant.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initial(label: string): string {
  const c = label.trim()[0];
  return c ? c.toUpperCase() : '?';
}
