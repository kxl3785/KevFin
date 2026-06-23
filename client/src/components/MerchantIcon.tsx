import { useState } from 'react';
import { merchantDomain, logoCandidates, avatarColor, initial } from '../lib/merchantLogo.ts';

/**
 * Small round merchant logo. For known merchants it tries a sequence of free
 * favicon services (DuckDuckGo, then Google); if every source fails to load it
 * falls back to a colored letter avatar — mirroring the generic icon fallback
 * in money apps. Unknown merchants go straight to the letter avatar.
 */
export default function MerchantIcon({ merchant, label, size = 24 }: {
  merchant: string;
  label: string;
  size?: number;
}) {
  const domain = merchantDomain(merchant);
  const candidates = domain ? logoCandidates(domain) : [];
  const [idx, setIdx] = useState(0);
  const showLogo = idx < candidates.length;

  const base: React.CSSProperties = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden', fontSize: size * 0.46, fontWeight: 700, lineHeight: 1,
  };

  if (showLogo) {
    return (
      <span style={{ ...base, background: '#fff', border: '1px solid var(--border)' }}>
        <img
          // key forces a fresh <img> per source so onError reliably advances
          key={candidates[idx]}
          src={candidates[idx]}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setIdx(i => i + 1)}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </span>
    );
  }

  const color = avatarColor(merchant || label);
  return (
    <span style={{ ...base, background: color + '22', color, border: `1px solid ${color}55` }}>
      {initial(label)}
    </span>
  );
}
