import { useCallback, useEffect, useState } from 'react';
import type { Entry } from '../types';
import { api } from '../api';
import { todayStr } from '../dates';
import Composer from '../components/Composer';
import EntryItem from '../components/EntryItem';

export default function TodayView({ onOpenDay }: { onOpenDay: (date: string) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const date = todayStr();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await api.listByDate(date));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="view">
      <h1 className="view-title">今天 · {date}</h1>
      <Composer date={date} onSaved={load} />

      {loading ? (
        <p className="muted">载入中…</p>
      ) : entries.length === 0 ? (
        <p className="muted">今天还没有记录,写下第一句吧。</p>
      ) : (
        <div className="entry-list">
          {entries.map((e) => (
            <EntryItem key={e.id} entry={e} onChanged={load} onDeleted={load} />
          ))}
        </div>
      )}
    </div>
  );
}
