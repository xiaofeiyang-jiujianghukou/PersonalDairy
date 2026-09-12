import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { Entry } from '@diary/shared';
import { getAllLocalEntries, companionApi } from '../api';
import { appendMessage, clearThread, loadThread } from '../lib/chatStore';
import { onDataChanged } from '../lib/dataEvents';
import { allowImageUrlTransform } from '../lib/image';
import ResolvedImage from './ResolvedImage';

/**
 * AI 心理导师 —— **一次性状态观察**。
 *
 * 定位:不是持续对话,而是"我现在想看看自己最近怎么样"时点一下,
 * 基于自己的日记生成一份观察报告;历史报告保留最近若干份,便于回看趋势。
 * (持续聊天请用「AI 陪伴」,那条是长期累积并多端同步的。)
 */

const THREAD = 'mentor-report';
const KEEP = 10; // 保留最近几份报告

const HOW_MANY_ENTRIES = 60; // 取最近多少条日记作为依据

async function gatherContext(): Promise<Entry[]> {
  try {
    const all = await getAllLocalEntries();
    return all
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, HOW_MANY_ENTRIES);
  } catch {
    return [];
  }
}

export default function MentorReportModal({ onClose }: { onClose: () => void }) {
  // 本地库里每条报告就是一条 assistant 消息(带时间戳),天然可多端同步
  const [reports, setReports] = useState(() => loadThread(THREAD).slice().reverse());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    return onDataChanged(() => setReports(loadThread(THREAD).slice().reverse()));
  }, []);

  async function run(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const context = await gatherContext();
      if (!context.length) {
        setError('还没有日记可作为依据,先写几条再来观察吧。');
        return;
      }
      const r = await companionApi.chat([{ role: 'user', content: '请看我最近的状态。' }], context, 'mentor-report');
      const msg = appendMessage(THREAD, 'assistant', r.reply);
      const next = loadThread(THREAD).slice().reverse();
      // 只保留最近 KEEP 份
      if (next.length > KEEP) {
        const keep = next.slice(0, KEEP);
        clearThread(THREAD);
        for (const m of keep.slice().reverse()) appendMessage(THREAD, 'assistant', m.content);
        setReports(keep);
      } else {
        setReports(next);
      }
      void msg;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const latest = reports[0];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal companion-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">AI 心理导师</h2>
        <p className="modal-hint">
          一次性看看自己最近的状态:基于你自己的日记,给出情绪、睡眠、压力方面的观察。
          <b>不是医生、不做诊断</b>;若出现强烈痛苦或危险念头,请务必联系专业帮助(心理援助热线 12356)。
        </p>

        <div className="companion-log">
          {busy && <div className="companion-msg assistant"><div className="markdown muted">正在看你的日记…</div></div>}
          {!busy && !latest && (
            <div className="companion-msg assistant">
              <div className="markdown">
                点下面的按钮,我会读你最近 {HOW_MANY_ENTRIES} 条日记,给你一份状态观察。
              </div>
            </div>
          )}
          {!busy && latest && (
            <div className="companion-msg assistant">
              <div className="markdown muted" style={{ marginBottom: 6 }}>
                {new Date(latest.createdAt).toLocaleString('zh-CN', { hour12: false })}
              </div>
              <div className="markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  urlTransform={allowImageUrlTransform}
                  components={{ img: ResolvedImage }}
                >
                  {latest.content}
                </ReactMarkdown>
              </div>
            </div>
          )}
          {showHistory &&
            reports.slice(1).map((m) => (
              <div key={m.id} className="companion-msg assistant">
                <div className="markdown muted" style={{ marginBottom: 6 }}>
                  历史 · {new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </div>
                <div className="markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                    urlTransform={allowImageUrlTransform}
                    components={{ img: ResolvedImage }}
                  >
                    {m.content}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
        </div>

        {error && <p className="companion-error">{error}</p>}

        <div className="modal-actions">
          {reports.length > 1 && (
            <button className="ghost" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? '收起历史' : `历史记录(${reports.length - 1})`}
            </button>
          )}
          <button className="primary" onClick={() => void run()} disabled={busy}>
            {busy ? '观察中…' : latest ? '再观察一次' : '开始观察'}
          </button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
