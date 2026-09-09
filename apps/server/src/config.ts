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
  imagesDir: string;
  /** 云端模式:关闭一切"内容存储/读取"端点,只留 身份/加密中继/AI(遵循"不存日记内容") */
  cloudMode: boolean;
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
  const envDataDir = process.env.DIARY_DATA_DIR?.trim();
  // 默认存在仓库 data/ 目录,与既有数据一致;空值视为未设置(可用 DIARY_DATA_DIR 覆盖)
  const dataDir = envDataDir ? envDataDir : path.join(repoRoot, 'data');

  return {
    port,
    dataDir,
    dbPath: path.join(dataDir, 'diary.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    imagesDir: path.join(dataDir, 'images'),
    cloudMode: process.env.CLOUD_MODE === '1',
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
