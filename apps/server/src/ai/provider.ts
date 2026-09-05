export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' } };

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  /** 纯文本,或多模态内容块(文本 + 图片) */
  content: string | AiContentPart[];
}

export interface AiChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface AiProvider {
  readonly name: string;
  chat(messages: AiMessage[], options?: AiChatOptions): Promise<string>;
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** DeepSeek 思考模式开关;'' 表示不发送该字段 */
  thinking?: 'enabled' | 'disabled' | '';
}

/**
 * 通用 OpenAI 兼容供应商,覆盖豆包 / DeepSeek(含视觉模型)/ 通义 Qwen / 本地 ollama 等,
 * 只需在配置里换 baseUrl + key + model 即可,业务代码无需改动。
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible';

  constructor(private readonly cfg: OpenAICompatibleConfig) {}

  async chat(messages: AiMessage[], options: AiChatOptions = {}): Promise<string> {
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        temperature: options.temperature ?? 0.6,
        max_tokens: options.maxTokens ?? 1024,
        stream: false,
        ...(this.cfg.thinking ? { thinking: { type: this.cfg.thinking } } : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI 请求失败 (${res.status}): ${text.slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('AI 返回内容为空');
    }
    return content.trim();
  }
}

/** 无密钥 / 显式禁用时的降级供应商:返回温和占位,保证产品其余功能不受影响。 */
export class NullProvider implements AiProvider {
  readonly name = 'null';

  async chat(): Promise<string> {
    return [
      '## 本月小结',
      '',
      '还没有配置 AI 服务,暂时无法自动归纳情绪。',
      '',
      '在 `.env` 中配置 `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` 后,',
      '即可让 AI 从你本月的文字(和图片)里归纳出一份只属于你的情绪小结。',
    ].join('\n');
  }
}
