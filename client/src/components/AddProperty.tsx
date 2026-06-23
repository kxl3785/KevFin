import { useState } from 'react';

interface Props {
  onAdded: () => void;
}

export default function AddProperty({ onAdded }: Props) {
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim()) return;
    setLoading(true);
    await fetch('/api/properties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    setAddress('');
    setLoading(false);
    onAdded();
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8 }}>
      <input
        value={address}
        onChange={e => setAddress(e.target.value)}
        placeholder="123 Main St, City, ST 12345"
      />
      <button type="submit" className="btn-primary" disabled={loading} style={{ whiteSpace: 'nowrap' }}>
        {loading ? 'Fetching…' : '+ Add Property'}
      </button>
    </form>
  );
}
