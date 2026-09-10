import { useEffect, useState } from 'react';
import type { Entry } from '../types';
import { api } from '../api';
import { friendlyDate, shiftDate } from '../dates';
import { useDataRefresh } from '../lib/useDataRefresh';
import Composer from '../components/Composer';
import EntryItem from '../components/EntryItem';

export default function DayView({
  date,
  onBack,
}: {
  date: string;
  onBack: () => void;
}) {
  const [current, setCurrent] = useState(date);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setCurrent(date);
  }, [date]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const list = await api.listByDate(current);
        if (alive) setEntries(list);
      } catch (e) {
        alert((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [current]);

  async function reload() {
    try {
      setEntries(await api.listByDate(current));
    } catch (e) {
      alert((e as Error).message);
    }
  }

  useDataRefresh(reload); // 同步合并了新条目 → 自动刷新

  return (
    <div className="view">
      <div className="day-nav">
        <button onClick={onBack}>‹ 日历</button>
        <button onClick={() => setCurrent(shiftDate(current, -1))}>前一天</button>
        <h1 className="view-title">{friendlyDate(current)}</h1>
        <button onClick={() => setCurrent(shiftDate(current, 1))}>后一天</button>
      </div>

      <Composer date={current} onSaved={reload} />

      {loading ? (
        <p className="muted">载入中…</p>
      ) : entries.length === 0 ? (
        <p className="muted">这一天还没有记录。</p>
      ) : (
        <div className="entry-list">
          {entries.map((e) => (
            <EntryItem key={e.id} entry={e} onChanged={reload} onDeleted={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
