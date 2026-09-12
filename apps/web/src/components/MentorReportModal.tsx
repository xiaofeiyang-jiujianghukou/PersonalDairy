import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { Entry } from '@diary/shared';
import { getAllLocalEntries, companionApi } from '../api';
import { appendMessage, clearThread, loadThread } from '../lib/chatStore';
import { onDataChanged } from '../lib/dataEvents';
import { scheduleSync } from '../lib/syncAuto';
import { allowImageUrlTransform } from '../lib/image';
import ResolvedImage from './ResolvedImage';

/**
 * AI 心理导师 —— **近况面板 + 专业疏导对话**。
 *
 *   · 近况面板:点一次"更新观察",基于你自己的日记生成一份状态报告(情绪/睡眠/压力…),
 *     保留最近若干份,可回看趋势 —— 这就是"时刻关注自己心理健康状态"的那块面板。
 *   · 对话:从面板上的引导语或输入框进入,像一位免费的专业心理疏导师那样陪你聊;
 *     对话持续保留,并和日记一样多端同步。
 *
 * 安全:不做诊断、不贴标签、不推荐药物;出现危机信号会引导联系专业帮助(热线 12356)。
 */

const REPORT_THREAD = 'mentor-report';
const CHAT_THREAD = 'mentor';
const KEEP_REPORTS = 10;
const HOW_MANY_ENTRIES = 60;

/** 面板上的引导语:让"不知道该说什么"的人也能开口。 */
const PROMPTS = [
  '我最近状态怎么样?',
  '我最近老是睡不好',
  '工作压得我有点喘不过气',
  '心里堵得慌,想说说',
];

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

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={allowImageUrlTransform}
        components={{ img: ResolvedImage }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default function MentorReportModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'panel' | 'chat'>('panel');
  const [reports, setReports] = useState(() => loadThread(REPORT_THREAD).slice().reverse());
  const [messages, setMessages] = useState(() => loadThread(CHAT_THREAD));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 别的设备更新了报告或对话 → 自动刷新
  useEffect(() => {
    return onDataChanged(() => {
      setReports(loadThread(REPORT_THREAD).slice().reverse());
      setMessages(loadThread(CHAT_THREAD));
    });
  }, []);

  useEffect(() => {
    if (tab === 'chat') scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [tab, messages, chatBusy]);

  async function runReport(): Promise<void> {
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
      appendMessage(REPORT_THREAD, 'assistant', r.reply);
      const next = loadThread(REPORT_THREAD).slice().reverse();
      if (next.length > KEEP_REPORTS) {
        const keep = next.slice(0, KEEP_REPORTS);
        clearThread(REPORT_THREAD);
        for (const m of keep.slice().reverse()) appendMessage(REPORT_THREAD, 'assistant', m.content);
        setReports(keep);
      } else {
        setReports(next);
      }
      scheduleSync(300); // 报告也同步到别的设备
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function send(text: string): Promise<void> {
    const t = text.trim();
    if (!t || chatBusy) return;
    const mine = appendMessage(CHAT_THREAD, 'user', t);
    const next = [...messages, mine];
    setMessages(next);
    setInput('');
    setChatBusy(true);
    setError(null);
    try {
      const context = await gatherContext();
      const r = await companionApi.chat(
        next.map((m) => ({ role: m.role, content: m.content })),
        context,
        'mentor',
      );
      setMessages([...next, appendMessage(CHAT_THREAD, 'assistant', r.reply)]);
      scheduleSync(300);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChatBusy(false);
    }
  }

  const latest = reports[0];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal companion-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">AI 心理导师</h2>

        <div className="mine-options" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button className={tab === 'panel' ? 'primary' : 'ghost'} onClick={() => setTab('panel')}>
            近况面板
          </button>
          <button className={tab === 'chat' ? 'primary' : 'ghost'} onClick={() => setTab('chat')}>
            对话疏导
          </button>
        </div>

        {tab === 'panel' ? (
          <>
            <p className="modal-hint">
              基于你自己的日记,看看最近的情绪、睡眠与压力状态。<b>不是医生、不做诊断</b>;
              若出现强烈痛苦或危险念头,请务必联系专业帮助(心理援助热线 12356)。
            </p>
            <div className="companion-log">
              {busy && (
                <div className="companion-msg assistant">
                  <div className="markdown muted">正在看你的日记…</div>
                </div>
              )}
              {!busy && !latest && (
                <div className="companion-msg assistant">
                  <Markdown text={`点下面的「开始观察」,我会读你最近 ${HOW_MANY_ENTRIES} 条日记,给你一份近况报告。`} />
                </div>
              )}
              {!busy && latest && (
                <div className="companion-msg assistant">
                  <div className="markdown muted" style={{ marginBottom: 6 }}>
                    {new Date(latest.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </div>
                  <Markdown text={latest.content} />
                </div>
              )}
              {showHistory &&
                reports.slice(1).map((m) => (
                  <div key={m.id} className="companion-msg assistant">
                    <div className="markdown muted" style={{ marginBottom: 6 }}>
                      历史 · {new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </div>
                    <Markdown text={m.content} />
                  </div>
                ))}
            </div>
            {error && <p className="companion-error">{error}</p>}
            <div className="modal-actions">
              {reports.length > 1 && (
                <button className="ghost" onClick={() => setShowHistory((v) => !v)}>
                  {showHistory ? '收起历史' : `历史(${reports.length - 1})`}
                </button>
              )}
              <button className="primary" onClick={() => void runReport()} disabled={busy}>
                {busy ? '观察中…' : latest ? '更新观察' : '开始观察'}
              </button>
              <button className="ghost" onClick={onClose}>关闭</button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-hint">
              像一位免费的专业心理疏导师那样陪你聊:先接住情绪,再一点点把事说清楚。
              不做诊断、不评判、不说教;危机情况会建议你联系专业帮助。
            </p>
            <div className="companion-log" ref={scrollRef}>
              {messages.length === 0 && (
                <div className="companion-msg assistant">
                  <Markdown text={'我在。想从哪儿说起都行 —— 也可以直接点下面一句开始。'} />
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`companion-msg ${m.role}`}>
                  <Markdown text={m.content} />
                </div>
              ))}
              {chatBusy && (
                <div className="companion-msg assistant">
                  <div className="markdown muted">正在想…</div>
                </div>
              )}
            </div>
            {error && <p className="companion-error">{error}</p>}
            <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
              {PROMPTS.map((p) => (
                <button key={p} className="ghost" onClick={() => void send(p)} disabled={chatBusy}>
                  {p}
                </button>
              ))}
            </div>
            <div className="companion-input">
              <input
                className="settings-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send(input)}
                placeholder="说点什么…(Enter 发送)"
                disabled={chatBusy}
              />
              <button className="primary" onClick={() => void send(input)} disabled={chatBusy || !input.trim()}>
                发送
              </button>
            </div>
            <div className="modal-actions">
              <button
                className="ghost"
                onClick={() => {
                  if (window.confirm('清空这段疏导对话?日记与报告都不受影响。')) {
                    clearThread(CHAT_THREAD);
                    setMessages([]);
                  }
                }}
              >
                清空对话
              </button>
              <button className="ghost" onClick={onClose}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
