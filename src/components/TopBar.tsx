import { InspectorTab } from '../data/clpsMissions';

interface TopBarProps {
  activeTab: InspectorTab | null;
  onSelectTab: (tab: InspectorTab) => void;
  onResetGlobe: () => void;
}

const NAV_ITEMS: { id: InspectorTab; label: string }[] = [
  { id: 'matrix', label: 'Missions' },
  { id: 'ephemeris', label: 'Ephemeris' },
  { id: 'czml', label: 'Orbital & CZML' },
  { id: 'pds', label: 'PDS Archive' },
  { id: 'drive', label: 'Google Drive' },
];

export function TopBar({ activeTab, onSelectTab, onResetGlobe }: TopBarProps) {
  return (
    <header className="relative z-20 h-12 px-5 bg-[#090C14] border-b border-slate-800/90 flex items-center justify-between gap-8">
      {/* Zone 1: Single-line Brand Wordmark */}
      <span className="text-[15px] font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
        NASA CLPS Lunar Browser
      </span>

      {/* Zone 2: 4 Clean Single-Line Navigation Links */}
      <nav className="hidden md:flex items-center gap-6 text-[13px] font-medium" aria-label="Primary Views">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`py-3.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isActive
                  ? 'border-amber-400 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: 1 Primary Action */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onResetGlobe}
          className="px-3.5 py-1.5 text-xs font-medium bg-amber-500 text-slate-950 rounded-md hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          Reset Globe
        </button>
      </div>
    </header>
  );
}
