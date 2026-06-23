import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccess } from 'react-plaid-link';

interface Props {
  onSuccess: () => void;
}

export default function ConnectPlaid({ onSuccess }: Props) {
  const [configured, setConfigured] = useState(false);
  const [linkToken, setLinkToken] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/plaid/status')
      .then(r => r.json())
      .then(d => setConfigured(Boolean(d.configured)))
      .catch(() => setConfigured(false));
  }, []);

  // Fetch a fresh link token only once Plaid is known to be configured.
  useEffect(() => {
    if (!configured) return;
    fetch('/api/plaid/link-token', { method: 'POST' })
      .then(r => r.json())
      .then(d => setLinkToken(d.link_token ?? null))
      .catch(() => {});
  }, [configured]);

  const onPlaidSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      await fetch('/api/plaid/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_token: publicToken,
          institution_name: metadata.institution?.name ?? 'Unknown',
        }),
      });
      onSuccess();
    },
    [onSuccess]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken ?? '',
    onSuccess: onPlaidSuccess,
  });

  if (!configured) return null; // hidden until Plaid credentials are set

  return (
    <button
      className="btn-primary"
      onClick={() => open()}
      disabled={!ready || !linkToken}
      title="Connect Frec or Bilt via Plaid"
    >
      + Plaid (Frec / Bilt)
    </button>
  );
}
