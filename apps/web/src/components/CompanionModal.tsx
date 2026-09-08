import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { Entry } from '@diary/shared';
import { api, companionApi, type CompanionMessage } from '../api';
import { allowImageUrlTransform } from '../lib/image';
import ResolvedImage from './ResolvedImage';

const GREETING: CompanionMessage = {
  role: 'assistant',
  content:
    '我在。你已经写下了不少日子。想聊聊哪一段?或者今天过得怎么样,也可以跟我说说。',
};

async function gatherContext(): Promise<Entry[]> {
  try {
    const all = await api.getAll();
    return all.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40);
  } catch {
    return [];
  }
}

export default function CompanionModal({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<CompanionMessage[]>([GREETING]);
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

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next: CompanionMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setLoading(true);
    setError(null);
    try {
      const r = await companionApi.chat(next, context);
      setMessages((m) => [...m, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal companion-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">AI 陪伴</h2>
        <p className="modal-hint">
          我读过你最近写下的日记,能陪你聊聊、安抚心情。仅依据你的文字回应,不评判、不说教。
        </p>

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
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
