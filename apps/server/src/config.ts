import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 加载项目根目录的 .env(若存在)。用 Node 内置能力,零依赖。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  // .env 不存在则忽略,允许纯环境变量方式
}

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  uploadsDir: string;
  ai: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    /** 纯文字模型(默认 deepseek-v4-pro) */
    textModel: string;
    /** 视觉模型(默认 deepseek-v4-flash-vision-exp) */
    visionModel: string;
    /** 思考模式开关(仅纯文字模型生效);'' 表示不发送该字段 */
    thinking: 'enabled' | 'disabled' | '';
  };
}

/**
 * 读取运行配置。
 * 数据默认落在用户目录 ~/.local/share/personal-diary(与代码仓库分离,升级不丢数据)。
 * AI 凭证从 .env / 环境变量读取,不写入代码、不入库。
 */
export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 4520);
  const dataDir =
    process.env.DIARY_DATA_DIR ??
    path.join(os.homedir(), '.local', 'share', 'personal-diary');

  return {
    port,
    dataDir,
    dbPath: path.join(dataDir, 'diary.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    ai: {
      provider: process.env.AI_PROVIDER ?? 'openai-compatible',
      baseUrl: process.env.AI_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: process.env.AI_API_KEY ?? '',
      textModel: process.env.AI_TEXT_MODEL ?? 'deepseek-v4-pro',
      visionModel: process.env.AI_VISION_MODEL ?? 'deepseek-v4-flash-vision-exp',
      thinking: (process.env.AI_THINKING ?? 'disabled') as 'enabled' | 'disabled' | '',
    },
  };
}
