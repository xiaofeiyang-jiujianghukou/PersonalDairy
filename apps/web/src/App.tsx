import { useState } from 'react';
import TodayView from './views/TodayView';
import MonthView from './views/MonthView';
import DayView from './views/DayView';
import SearchView from './views/SearchView';
import SettingsModal from './components/SettingsModal';
import { exportUrl } from './api';

type View =
  | { kind: 'today' }
  | { kind: 'month' }
  | { kind: 'day'; date: string }
  | { kind: 'search' };

export default function App() {
  const [view, setView] = useState<View>({ kind: 'today' });
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">我的日记</div>
        <nav className="nav">
          <button
            className={view.kind === 'today' ? 'active' : ''}
            onClick={() => setView({ kind: 'today' })}
          >
            今天
          </button>
          <button
            className={view.kind === 'month' ? 'active' : ''}
            onClick={() => setView({ kind: 'month' })}
          >
            日历
          </button>
          <button
            className={view.kind === 'search' ? 'active' : ''}
            onClick={() => setView({ kind: 'search' })}
          >
            搜索
          </button>
          <button onClick={() => setShowSettings(true)} title="配置日记服务器">
            服务器
          </button>
          <a className="export-link" href={exportUrl()} title="导出全部日记为 Markdown">
            导出
          </a>
        </nav>
      </header>

      <main className="main">
        {view.kind === 'today' && (
          <TodayView onOpenDay={(date) => setView({ kind: 'day', date })} />
        )}
        {view.kind === 'month' && (
          <MonthView onOpenDay={(date) => setView({ kind: 'day', date })} />
        )}
        {view.kind === 'day' && (
          <DayView date={view.date} onBack={() => setView({ kind: 'month' })} />
        )}
        {view.kind === 'search' && (
          <SearchView onOpenDay={(date) => setView({ kind: 'day', date })} />
        )}
      </main>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
