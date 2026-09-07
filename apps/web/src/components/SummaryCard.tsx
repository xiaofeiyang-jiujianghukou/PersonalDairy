import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { MonthSummary } from '../types';
import { api } from '../api';
import { allowImageUrlTransform } from '../lib/image';
import ResolvedImage from './ResolvedImage';

export default function SummaryCard({ month }: { month: string }) {
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read() {
    setError(null);
    try {
      const r = await api.summaryRead(month);
      if (r.exists && r.summary) {
        setSummary(r.summary);
        setStale(!!r.stale);
      } else {
        setSummary(null);
      }
    } catch (e) {
      // 该月没有日记时后端返回 404,这里静默处理为"尚无小结"
      setSummary(null);
    }
  }

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.summaryGenerate(month);
      setSummary(r.summary);
      setStale(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void read();
  }, [month]);

  return (
    <div className="summary-card">
      <div className="summary-head">
        <span className="summary-title">本月小结</span>
        <div className="summary-actions">
          {stale && <span className="hint warn">日记有更新,小结可能已过时</span>}
          <button onClick={generate} disabled={loading}>
            {loading ? '生成中…' : summary ? '重新生成' : '生成'}
          </button>
        </div>
      </div>

      {error && <p className="muted">{error}</p>}
      {!summary && !error && (
        <p className="muted">
          还没有小结。点「生成」,让 AI 从你本月的文字里,归纳出一份只属于你的情绪小结。
        </p>
      )}
      {summary && (
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} urlTransform={allowImageUrlTransform} components={{ img: ResolvedImage }}>
            {summary.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
