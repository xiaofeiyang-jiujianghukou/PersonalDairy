import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { Entry } from '@diary/shared';
import { getAllLocalEntries, companionApi } from '../api';
import { appendMessage, clearThread, loadThread } from '../lib/chatStore';
import { onDataChanged } from '../lib/dataEvents';
import { scheduleSync } from '../lib/syncAuto';
import type { ChatMessage } from '@diary/shared/syncEngine';
import { allowImageUrlTransform } from '../lib/image';
import ResolvedImage from './ResolvedImage';

/** 两种人格:陪伴者(聊心事) / 心理导师(关注心理健康状态)。 */
export type CompanionMode = 'companion' | 'mentor';

const GREETINGS: Record<CompanionMode, { role: 'assistant'; content: string }> = {
  companion: {
    role: 'assistant',
    content: '我在。你已经写下了不少日子。想聊聊哪一段?或者今天过得怎么样,也可以跟我说说。',
  },
  mentor: {
    role: 'assistant',
    content:
      '我会读你最近的日记,陪你一起留意自己的状态 —— 情绪、睡眠、压力、身体感受。想从哪开始?也可以直接问我"我最近怎么样"。',
  },
};

const META: Record<CompanionMode, { title: string; hint: string; chatKey: string }> = {
  companion: {
    title: 'AI 陪伴',
    hint: '我读过你最近写下的日记,能陪你聊聊、安抚心情。仅依据你的文字回应,不评判、不说教。',
    chatKey: 'diary.chat.companion',
  },
  mentor: {
    title: 'AI 心理导师',
    hint:
      '基于你自己的日记陪你观察心理健康状态(情绪趋势、睡眠、压力来源)。不是医生、不做诊断;若出现强烈痛苦或危险念头,请务必联系专业帮助。',
    chatKey: 'diary.chat.mentor',
  },
};

/** 首条问候(异步/同步初始态用它,之后都在本地库里)。 */
function greetingFor(mode: CompanionMode): ChatMessage {
  const g = GREETINGS[mode];
  return { id: `greet-${mode}`, thread: mode, role: 'assistant', content: g.content, createdAt: '1970-01-01T00:00:00.000Z' };
}

async function gatherContext(): Promise<Entry[]> {
  try {
    const all = await getAllLocalEntries();
    return all.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40);
  } catch {
    return [];
  }
}

export default function CompanionModal({
  onClose,
  mode = 'companion',
}: {
  onClose: () => void;
  mode?: CompanionMode;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = loadThread(mode);
    return saved.length ? saved : [greetingFor(mode)];
  });
  const [input, setInput] = useState('');
  const [context, setContext] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void gatherContext().then(setContext);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  // 同步(别的设备聊过 / 本机被对端补齐)→ 自动刷新当前对话
  useEffect(() => {
    return onDataChanged(() => {
      const saved = loadThread(mode);
      if (saved.length) setMessages(saved);
    });
  }, [mode]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const mine = appendMessage(mode, 'user', text); // 落盘(带 id/时间戳)→ 会被同步到其它端
    scheduleSync(300); // 立刻把这次对话推给在线端(不必等日记变化)
    const next = [...messages, mine];
    setMessages(next);
    setInput('');
    setLoading(true);
    setError(null);
    try {
      const r = await companionApi.chat(
        next.map((m) => ({ role: m.role, content: m.content })),
        context,
        mode,
      );
      setMessages([...next, appendMessage(mode, 'assistant', r.reply)]);
      scheduleSync(300); // AI 的回复同样带出去
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal companion-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{META[mode].title}</h2>
        <p className="modal-hint">{META[mode].hint}</p>

        <div className="companion-log" ref={scrollRef}>
          {messages.map((m, i) => (
            <div key={i} className={`companion-msg ${m.role}`}>
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
          {loading && (
            <div className="companion-msg assistant">
              <div className="markdown muted">正在想…</div>
            </div>
          )}
        </div>

        {error && <p className="companion-error">{error}</p>}

        <div className="companion-input">
          <input
            className="settings-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="写点什么…(Enter 发送)"
            disabled={loading}
            autoFocus
          />
          <button className="primary" onClick={send} disabled={loading || !input.trim()}>
            发送
          </button>
        </div>
        <div className="modal-actions">
          <button
            className="ghost"
            onClick={() => {
              if (window.confirm('清空这段对话?日记本身不受影响。')) {
                clearThread(mode);
                setMessages([greetingFor(mode)]);
              }
            }}
          >
            清空对话
          </button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
