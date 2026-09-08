import type { Entry } from '@diary/shared';
import type { AiMessage, AiProvider } from './provider.js';

export interface CompanionMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 抽取日记中内嵌图片的 Markdown 引用,交谈模型不做看图,替换为占位。 */
const IMG_MD_RE = /!\[[^\]]*\]\([^)]+\)/g;

/** 把日记条目拼成对话背景文本(纯函数,便于自测)。 */
export function buildCompanionContext(entries: Entry[]): string {
  return entries
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
    .map((e) => `【${e.date}】\n${e.content.replace(IMG_MD_RE, '[图片]')}`)
    .join('\n\n')
    .trim();
}

/** 纯函数:根据背景 + 用户消息构造发给模型的消息数组(便于自测)。 */
export function buildCompanionMessages(context: Entry[], messages: CompanionMessage[]): AiMessage[] {
  const ctx = buildCompanionContext(context);
  const system: AiMessage = {
    role: 'system',
    content: [
      '你是一位温柔、克制、真诚的私人日记陪伴者。你熟悉用户写下的日记,像一位懂你的老朋友。',
      '只依据用户日记给出的内容去共情、回应;信息不足就温和地问一句,不编造、不过度解读、不评判、不说教、不给具体行动建议。',
      '回答真诚、口语化,不堆砌书面词,不刷屏;必要时可引用用户日记里的原句,但要自然。',
      ctx ? `\n\n以下是用户的部分日记(按日期,仅作背景,不要逐条复述):\n\n${ctx}` : '',
    ].join('\n'),
  };
  const out: AiMessage[] = [system];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (!m.content?.trim()) continue;
    out.push({ role: m.role, content: m.content.trim() });
  }
  return out;
}

/**
 * 让 AI 陪聊:将背景(日记)+ 对话交给模型,返回回复。
 * 要求 messages 以一条 user 消息结尾(客户端需保证)。
 */
export async function chatWithDiary(
  context: Entry[],
  messages: CompanionMessage[],
  provider: AiProvider,
): Promise<string> {
  const aiMessages = buildCompanionMessages(context, messages);
  const last = aiMessages[aiMessages.length - 1];
  if (last?.role !== 'user') throw new Error('对话需以用户消息结尾');
  return provider.chat(aiMessages, { temperature: 0.8, maxTokens: 800 });
}
