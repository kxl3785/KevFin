import PageFaq from './PageFaq.tsx';
import DocImport from './DocImport.tsx';
import Setup from './Setup.tsx';

export type View = 'dashboard' | 'allocation' | 'budget' | 'forecast';

const svgProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

/* Nav glyphs share the same stroke style as the action icons below; sized to sit
   inline with the label text. They inherit `currentColor`, so they pick up the
   active/hover colours from `.nav-btn` automatically. */
const navIconProps = { ...svgProps, width: 17, height: 17 };

function DashboardIcon() {
  return (
    <svg {...navIconProps}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.4V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.4" />
      <path d="M10 21v-6h4v6" />
    </svg>
  );
}

function InvestmentsIcon() {
  return (
    <svg {...navIconProps}>
      <path d="M4 4v16h16" />
      <path d="M8 16v-4" />
      <path d="M13 16V8" />
      <path d="M18 16v-6" />
    </svg>
  );
}

function BudgetIcon() {
  return (
    <svg {...navIconProps}>
      <path d="M19 7V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a1 1 0 0 0 1-1v-3" />
      <path d="M21 11h-5a2 2 0 0 0 0 4h5v-4Z" />
    </svg>
  );
}

function ForecastIcon() {
  return (
    <svg {...navIconProps}>
      <path d="M3 17 9 11l4 4 8-8" />
      <path d="M16 7h5v5" />
    </svg>
  );
}

const NAV_ITEMS: { view: View; label: string; Icon: () => JSX.Element; title: string }[] = [
  { view: 'dashboard', label: 'Dashboard', Icon: DashboardIcon, title: 'Net worth overview' },
  { view: 'allocation', label: 'Investments', Icon: InvestmentsIcon, title: 'View investment allocation' },
  { view: 'budget', label: 'Budget', Icon: BudgetIcon, title: 'Budget & transactions' },
  { view: 'forecast', label: 'Forecast', Icon: ForecastIcon, title: 'Forecast your future net worth' },
];

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
            <item.Icon /> {item.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
        <button
          className="btn-icon"
          onClick={onTogglePrivacy}
          title={privacy ? 'Show balances' : 'Hide balances'}
          aria-label={privacy ? 'Show balances' : 'Hide balances'}
        >
          {privacy ? <EyeOffIcon /> : <EyeIcon />}
        </button>
        <DocImport />
        <Setup />
        <PageFaq view={view} />
      </div>
    </div>
  );
}
