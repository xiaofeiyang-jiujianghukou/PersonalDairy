import type { Entry } from '@diary/shared';
import type { AiContentPart, AiMessage, AiProvider } from './provider.js';
import { extractImageRefs, imageRefToDataUrl } from '../images.js';

/**
 * 把当月日记(文字 + 其中插入的图片)交给视觉模型,归纳成一份温和的月度情绪小结。
 * 图片以 base64 data URL 内联在 user 消息里,模型能"看到"表情包 / 照片。
 */
export async function summarizeMonth(
  entries: Entry[],
  provider: AiProvider,
  uploadsDir: string,
): Promise<string> {
  const system: AiMessage = {
    role: 'system',
    content: [
      '你是一位温柔、克制、真诚的私人日记陪伴者。你只忠实于用户自己的文字和图片,',
      '不编造、不过度解读、不评判、不说教。',
      '',
      '你的任务:把用户这个月的日记(含图片),归纳成一份温和的月度情绪小结。',
      '',
      '要求:',
      '1. 用中文,语气像一位懂你的老朋友,温和但不煽情。',
      '2. 用小节组织:总体情绪、生活状态、工作状态、值得记住的瞬间、一句送给自己的话。',
      '3. 只依据给出的日记内容,若某方面信息不足就如实说「记录较少」。',
      '4. 图片可能是表情包、截图或照片,把它们当作理解情绪的线索,但不要逐张描述。',
      '5. 不要打分、不要贴标签、不要给具体行动建议,只做共情式的回顾。',
      '6. 输出 Markdown。',
    ].join('\n'),
  };

  const parts: AiContentPart[] = [
    { type: 'text', text: '以下是我这个月记下的所有日记:\n\n' },
  ];
  for (const e of entries) {
    parts.push({ type: 'text', text: `【${e.date}】\n${e.content}\n\n` });
    for (const ref of extractImageRefs(e.content)) {
      const dataUrl = imageRefToDataUrl(ref, uploadsDir);
      if (dataUrl) {
        parts.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'low' } });
      }
    }
  }
  parts.push({ type: 'text', text: '请为我归纳这个月的情绪小结。' });

  const user: AiMessage = { role: 'user', content: parts };

  return provider.chat([system, user], { temperature: 0.6, maxTokens: 1500 });
}
