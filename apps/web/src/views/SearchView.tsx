import { useCallback, useState } from 'react';
import type { SearchResult } from '../types';
import { api } from '../api';
import { useDataRefresh } from '../lib/useDataRefresh';

export default function SearchView({ onOpenDay }: { onOpenDay: (date: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    if (!q.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      setResults(await api.search(q.trim()));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q]);

  useDataRefresh(() => {
    // 只在该视图已经搜过时刷新结果,不改变用户的输入
    if (searched) void run();
  });

  return (
    <div className="view">
      <h1 className="view-title">搜索</h1>
      <div className="search-box">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="搜索你写过的文字……"
          autoFocus
        />
        <button className="primary" onClick={run} disabled={loading || !q.trim()}>
          {loading ? '搜索中…' : '搜索'}
        </button>
      </div>

      {searched && !loading && results.length === 0 && (
        <p className="muted">没有找到相关内容。</p>
      )}
      <div className="search-results">
        {results.map((r) => (
          <button key={r.id} className="search-item" onClick={() => onOpenDay(r.date)}>
            <div className="search-date">{r.date}</div>
            <div className="search-snippet">{r.snippet}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
