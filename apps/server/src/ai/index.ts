import { loadConfig } from '../config.js';
import {
  NullProvider,
  OpenAICompatibleProvider,
  type AiProvider,
} from './provider.js';

let textProvider: AiProvider | null = null;
let visionProvider: AiProvider | null = null;

function build(model: string, thinking: 'enabled' | 'disabled' | ''): AiProvider {
  const { ai } = loadConfig();
  if (ai.provider === 'null' || !ai.apiKey) return new NullProvider();
  return new OpenAICompatibleProvider({
    baseUrl: ai.baseUrl,
    apiKey: ai.apiKey,
    model,
    thinking,
  });
}

/** 纯文字模型(默认 deepseek-v4-pro)。 */
export function getTextProvider(): AiProvider {
  if (!textProvider) {
    const { ai } = loadConfig();
    textProvider = build(ai.textModel, ai.thinking);
  }
  return textProvider;
}

/** 视觉模型(默认 deepseek-v4-flash-vision-exp);视觉模型不发送 thinking 字段。 */
export function getVisionProvider(): AiProvider {
  if (!visionProvider) {
    const { ai } = loadConfig();
    visionProvider = build(ai.visionModel, '');
  }
  return visionProvider;
}
