import type { ChatMessage } from '@diary/shared/syncEngine';

/**
 * AI 对话的本地库。
 *   · companion       —— AI 陪伴(长期聊天,持续累积)
 *   · mentor-report   —— AI 心理导师的历次"一次性观察报告"
 * 两者都经同一条加密链路多端同步。
 *
 * 与日记同一套原则:内容只存在终端,经同一条加密信箱链路在多端之间同步。
 * 每条消息生成后不再修改 → 带上稳定 id 与时间戳,合并时按 id 去重即可,不存在冲突。
 */

const KEY = (thread: string): string => `diary.chat.${thread}`;
const CAP = 300; // 每个线程最多保留多少条(防止无限增长)

function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* 忽略 */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function read(thread: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(KEY(thread));
    if (!raw) return [];
    const arr = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((m) => m && m.id && (m.role === 'user' || m.role === 'assistant') && m.content);
  } catch {
    return [];
  }
}

function write(thread: string, messages: ChatMessage[]): void {
  try {
    const sorted = messages.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    localStorage.setItem(KEY(thread), JSON.stringify(sorted.slice(-CAP)));
  } catch {
    /* 存不下就忽略(不影响本次会话) */
  }
}

/** 读某个线程的全部消息(按时间排序)。 */
export function loadThread(thread: string): ChatMessage[] {
  return read(thread);
}

/** 追加一条消息并落盘,返回该条。 */
export function appendMessage(thread: string, role: 'user' | 'assistant', content: string): ChatMessage {
  const msg: ChatMessage = { id: uuid(), thread, role, content, createdAt: new Date().toISOString() };
  write(thread, [...read(thread), msg]);
  return msg;
}

/** 清空某个线程(日记本身不受影响)。 */
export function clearThread(thread: string): void {
  try {
    localStorage.removeItem(KEY(thread));
  } catch {
    /* 忽略 */
  }
}

/** 已知的对话线程(UI 里用到的两个)。 */
export const CHAT_THREADS = ['companion', 'mentor', 'mentor-report'] as const;

/** 同步引擎用:本机全部对话消息。 */
export function chatAll(): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of CHAT_THREADS) out.push(...read(t));
  return out;
}

/** 同步引擎用:写入对端带来的对话消息(按 id 去重,幂等)。 */
export function chatPut(messages: ChatMessage[]): void {
  const byThread = new Map<string, Map<string, ChatMessage>>();
  for (const t of CHAT_THREADS) byThread.set(t, new Map(read(t).map((m) => [m.id, m])));
  let touched = false;
  for (const m of messages) {
    if (!m?.id || !m.thread) continue;
    const box = byThread.get(m.thread);
    if (!box) continue; // 未知线程先不收(避免脏数据)
    if (box.has(m.id)) continue;
    box.set(m.id, m);
    touched = true;
  }
  if (!touched) return;
  for (const [t, box] of byThread) write(t, [...box.values()]);
}
