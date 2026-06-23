import PageFaq from './PageFaq.tsx';

export type View = 'dashboard' | 'allocation' | 'budget' | 'forecast';

const NAV_ITEMS: { view: View; label: string; icon: string; title: string }[] = [
  { view: 'dashboard', label: 'Dashboard', icon: '🏠', title: 'Net worth overview' },
  { view: 'allocation', label: 'Investments', icon: '📊', title: 'View investment allocation' },
  { view: 'budget', label: 'Budget', icon: '💰', title: 'Budget & transactions' },
  { view: 'forecast', label: 'Forecast', icon: '🔮', title: 'Forecast your future net worth' },
];

const svgProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

function EyeIcon() {
  return (
    <svg {...svgProps}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg {...svgProps}>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M6.61 6.61A18.5 18.5 0 0 0 2 12s3.5 7 10 7a9.12 9.12 0 0 0 5.39-1.61" />
      <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg {...svgProps} className={spinning ? 'spin' : undefined}>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/**
 * Persistent top bar shown on every view. The nav segment lets the user jump
 * straight between the dashboard and each section (no "back" step); Hide and
 * Refresh are compact icon-only actions. `onRefresh` is optional — it only
 * appears where a refresh makes sense (the dashboard).
 */
export default function TopNav({ view, onNavigate, privacy, onTogglePrivacy, onRefresh, refreshing }: {
  view: View;
  onNavigate: (v: View) => void;
  privacy: boolean;
  onTogglePrivacy: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 28, flexWrap: 'wrap' }}>
      <div className="nav-group">
        {NAV_ITEMS.map(item => (
          <button
            key={item.view}
            className={'nav-btn' + (view === item.view ? ' active' : '')}
            onClick={() => onNavigate(item.view)}
            title={item.title}
            aria-current={view === item.view ? 'page' : undefined}
          >
            {item.icon} {item.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className="btn-icon"
          onClick={onTogglePrivacy}
          title={privacy ? 'Show balances' : 'Hide balances'}
          aria-label={privacy ? 'Show balances' : 'Hide balances'}
        >
          {privacy ? <EyeOffIcon /> : <EyeIcon />}
        </button>
        {onRefresh && (
          <button
            className="btn-icon"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh now"
            aria-label="Refresh now"
          >
            <RefreshIcon spinning={refreshing} />
          </button>
        )}
        <PageFaq view={view} />
      </div>
    </div>
  );
}
