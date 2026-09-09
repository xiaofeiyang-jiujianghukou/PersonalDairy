import { useEffect, useState } from 'react';
import TodayView from './views/TodayView';
import MonthView from './views/MonthView';
import DayView from './views/DayView';
import SearchView from './views/SearchView';
import MyView from './views/MyView';
import AuthGate from './components/AuthGate';
import { getToken } from './api';
import { autoSync } from './lib/syncAuto';

type View =
  | { kind: 'today' }
  | { kind: 'month' }
  | { kind: 'day'; date: string }
  | { kind: 'search' }
  | { kind: 'mine' };

export default function App() {
  const [authed, setAuthed] = useState<boolean>(() => !!getToken());
  const [view, setView] = useState<View>({ kind: 'today' });

  // 打开应用:已登录且本地优先已配对 → 自动全量同步
  useEffect(() => {
    if (authed) void autoSync();
  }, [authed]);

  if (!authed) return <AuthGate onAuthed={() => setAuthed(true)} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">PersonalDiary</div>
        <nav className="nav">
          <button className={view.kind === 'today' ? 'active' : ''} onClick={() => setView({ kind: 'today' })}>
            今天
          </button>
          <button className={view.kind === 'month' ? 'active' : ''} onClick={() => setView({ kind: 'month' })}>
            日历
          </button>
          <button className={view.kind === 'search' ? 'active' : ''} onClick={() => setView({ kind: 'search' })}>
            搜索
          </button>
          <button className={view.kind === 'mine' ? 'active' : ''} onClick={() => setView({ kind: 'mine' })}>
            我的
          </button>
        </nav>
      </header>

      <main className="main">
        {view.kind === 'today' && <TodayView onOpenDay={(date) => setView({ kind: 'day', date })} />}
        {view.kind === 'month' && <MonthView onOpenDay={(date) => setView({ kind: 'day', date })} />}
        {view.kind === 'day' && <DayView date={view.date} onBack={() => setView({ kind: 'month' })} />}
        {view.kind === 'search' && <SearchView onOpenDay={(date) => setView({ kind: 'day', date })} />}
        {view.kind === 'mine' && <MyView onOpenDay={(date) => setView({ kind: 'day', date })} />}
      </main>
    </div>
  );
}
