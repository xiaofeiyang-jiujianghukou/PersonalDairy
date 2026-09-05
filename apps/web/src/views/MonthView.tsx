import { useEffect, useMemo, useState } from 'react';
import { format, isSameDay, isSameMonth } from 'date-fns';
import type { Entry } from '../types';
import { api } from '../api';
import { monthGrid, weekdayLabels } from '../dates';
import SummaryCard from '../components/SummaryCard';

export default function MonthView({ onOpenDay }: { onOpenDay: (date: string) => void }) {
  const now = new Date();
  const [cursor, setCursor] = useState({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  });
  const [entries, setEntries] = useState<Entry[]>([]);

  const month = `${cursor.year}-${String(cursor.month).padStart(2, '0')}`;

  useEffect(() => {
    void (async () => {
      try {
        setEntries(await api.listByMonth(month));
      } catch (e) {
        alert((e as Error).message);
      }
    })();
  }, [month]);

  const days = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor.year, cursor.month]);
  const countsByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries) map.set(e.date, (map.get(e.date) ?? 0) + 1);
    return map;
  }, [entries]);

  const anchor = new Date(cursor.year, cursor.month - 1, 1);

  const prev = () => {
    const d = new Date(cursor.year, cursor.month - 2, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 });
  };
  const next = () => {
    const d = new Date(cursor.year, cursor.month, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 });
  };

  return (
    <div className="view">
      <div className="month-nav">
        <button onClick={prev} aria-label="上个月">‹</button>
        <h1 className="view-title">{cursor.year} 年 {cursor.month} 月</h1>
        <button onClick={next} aria-label="下个月">›</button>
      </div>

      <SummaryCard month={month} />

      <div className="calendar">
        {weekdayLabels.map((d) => (
          <div key={d} className="cal-head">{d}</div>
        ))}
        {days.map((d) => {
          const ds = format(d, 'yyyy-MM-dd');
          const inMonth = isSameMonth(d, anchor);
          const count = countsByDay.get(ds) ?? 0;
          const isToday = isSameDay(d, new Date());
          return (
            <button
              key={ds}
              className={`cal-day ${inMonth ? '' : 'out'} ${isToday ? 'today' : ''}`}
              onClick={() => onOpenDay(ds)}
              title={count > 0 ? `${ds} · ${count} 条记录` : ds}
            >
              <span className="cal-num">{d.getDate()}</span>
              {count > 0 && <span className="cal-dot" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
