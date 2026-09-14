import { useCallback, useEffect, useState } from 'react';
import type { Entry } from '../types';
import { api } from '../api';
import { todayStr } from '../dates';
import { useDataRefresh } from '../lib/useDataRefresh';
import Composer from '../components/Composer';
import EntryItem from '../components/EntryItem';

export default function TodayView({ onOpenDay }: { onOpenDay: (date: string) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const date = todayStr();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listByDate(date);
      /*
       * 「今天」列表**倒序**(最新写的在最上面):
       * 输入框在上面,刚写完的一条自然出现在紧挨输入框的位置,不用往下翻。
       * 注意:从日历点进来的那一天走的是 DayView,那边保持**正序**(按时间顺序回顾),
       * 两种顺序刻意不同 —— 这里是"接着写",那里是"回头看"。
       */
      setEntries(
        list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
      );
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  useDataRefresh(load); // 同步合并了新条目 → 自动刷新

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
