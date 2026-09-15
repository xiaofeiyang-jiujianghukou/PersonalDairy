import { useEffect, useMemo, useState } from 'react';
import type { SyncLogCategory } from '@diary/shared/syncEngine';
import { clearSyncLog, formatSyncLog, readSyncLog, SYNC_LOG_CAT_LABELS } from '../lib/syncLog';

const ALL_CATS: Array<SyncLogCategory | 'all'> = [
  'all',
  'write',
  'notify',
  'recvNotify',
  'watermark',
  'range',
  'sync',
  'error',
];

const BADGE_COLOR: Record<SyncLogCategory, string> = {
  write: '#2e7d32',
  notify: '#1565c0',
  recvNotify: '#00695c',
  watermark: '#6a1b9a',
  range: '#e65100',
  sync: '#37474f',
  error: '#c62828',
};

/** 本机同步日志查看/管理(每台终端独立存一份)。 */
export default function LogViewerModal({ onClose }: { onClose: () => void }) {
  const [filter, setFilter] = useState<SyncLogCategory | 'all'>('all');
  const [entries, setEntries] = useState(() => readSyncLog());
  const [notice, setNotice] = useState('');

  // 打开期间每 2 秒刷新一次,实时跟进新日志
  useEffect(() => {
    const t = setInterval(() => setEntries(readSyncLog()), 2000);
    return () => clearInterval(t);
  }, []);

  const shown = useMemo(() => {
    const list = filter === 'all' ? entries : entries.filter((e) => e.cat === filter);
    return list.slice().reverse(); // 最新在前
  }, [entries, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[e.cat] = (c[e.cat] ?? 0) + 1;
    return c;
  }, [entries]);

  async function doExport() {
    try {
      const text = formatSyncLog(shown);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setNotice(`已复制 ${shown.length} 条日志到剪贴板。`);
      } else {
        setNotice('当前环境不支持复制,请手动选择列表文本。');
      }
    } catch {
      setNotice('复制失败,请手动选择列表文本。');
    }
    setTimeout(() => setNotice(''), 2500);
  }

  function doClear() {
    if (!window.confirm(`清空本机全部 ${entries.length} 条日志?(不影响任何日记数据)`)) return;
    clearSyncLog();
    setEntries([]);
    setNotice('已清空。');
    setTimeout(() => setNotice(''), 2000);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal log-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">日志管理</h2>
        <p className="modal-hint">本机同步日志(写日记 / 通知 / 水位 / 区间 / 错误),仅存于这台设备。</p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {ALL_CATS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setFilter(c)}
              style={{
                padding: '4px 10px',
                borderRadius: 14,
                border: '1px solid #ddd',
                background: filter === c ? '#1565c0' : '#fff',
                color: filter === c ? '#fff' : '#333',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {c === 'all' ? '全部' : SYNC_LOG_CAT_LABELS[c]}
              {counts[c] ? <span style={{ marginLeft: 4, opacity: 0.75 }}>{counts[c]}</span> : null}
            </button>
          ))}
        </div>

        <div
          style={{
            height: '48vh',
            overflowY: 'auto',
            background: '#fafafa',
            border: '1px solid #eee',
            borderRadius: 8,
            padding: 8,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {shown.length === 0 ? (
            <p style={{ color: '#999', textAlign: 'center', marginTop: 32 }}>暂无日志</p>
          ) : (
            shown.map((e, i) => (
              <div key={`${e.ts}-${i}`} style={{ marginBottom: 4, wordBreak: 'break-all' }}>
                <span style={{ color: '#999' }}>{e.ts ? new Date(e.ts).toISOString().slice(11, 23) : '--:--:--.---'}</span>{' '}
                <span
                  style={{
                    color: '#fff',
                    background: BADGE_COLOR[e.cat] ?? '#607d8b',
                    borderRadius: 3,
                    padding: '0 4px',
                    fontSize: 10,
                  }}
                >
                  {SYNC_LOG_CAT_LABELS[e.cat] ?? e.cat}
                </span>{' '}
                <span>{e.msg}</span>
              </div>
            ))
          )}
        </div>

        {notice && <p className="ok" style={{ textAlign: 'center' }}>{notice}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={() => setEntries(readSyncLog())}>刷新</button>
          <button className="ghost" onClick={doExport}>导出(复制)</button>
          <button className="ghost" onClick={doClear}>清空日志</button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
