import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import QRCode from 'qrcode';
import {
  DATE_RE,
  MONTH_RE,
  type Entry,
  type EntryCreateInput,
  type EntryUpdateInput,
} from '@diary/shared';

import { loadConfig } from './config.js';
import {
  initDb,
  listEntriesByDate,
  listEntriesByMonth,
  listAllEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  searchEntries,
  entriesHash,
  getSummary,
  upsertSummary,
  getAllEntriesForSync,
  applySyncedEntries,
} from './db.js';
import { getTextProvider, getVisionProvider } from './ai/index.js';
import { summarizeMonth } from './ai/summary.js';
import {
  entriesContainImages,
  imageIdFromDataUrl,
  decodeImageDataUrl,
  saveImage,
  readImage,
  listImageIds,
  normalizeLegacyImageRefs,
} from './images.js';
import { detectImageMime } from '@diary/shared/images';
import { decryptObject, encryptObject, generateSyncKey } from '@diary/shared/syncCrypto';

const config = loadConfig();
initDb(config.dbPath);

const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024 }); // 64MB,容纳含图片的同步负载

// 允许本机 / 局域网前端访问(本地优先应用,不做鉴权,数据只在你自己的机器上)。
await app.register(cors, { origin: true });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- 健康检查 ----------
app.get('/api/health', async () => ({
  ok: true,
  aiConfigured: config.ai.apiKey !== '' && config.ai.provider !== 'null',
  textModel: config.ai.textModel,
  visionModel: config.ai.visionModel,
  dataDir: config.dataDir,
}));

// ---------- 日记 ----------
app.get('/api/entries', async (req, reply) => {
  const { date, month } = req.query as { date?: string; month?: string };
  if (date) {
    if (!DATE_RE.test(date)) return reply.code(400).send({ error: '日期格式应为 YYYY-MM-DD' });
    return listEntriesByDate(date);
  }
  if (month) {
    if (!MONTH_RE.test(month)) return reply.code(400).send({ error: '月份格式应为 YYYY-MM' });
    return listEntriesByMonth(month);
  }
  return listAllEntries();
});

app.get('/api/entries/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: '非法 ID' });
  const entry = getEntry(id);
  if (!entry) return reply.code(404).send({ error: '没有这条日记' });
  return entry;
});

app.post('/api/entries', async (req, reply) => {
  const body = req.body as Partial<EntryCreateInput>;
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    return reply.code(400).send({ error: '内容不能为空' });
  }
  if (!body.date || !DATE_RE.test(body.date)) {
    return reply.code(400).send({ error: '日期格式应为 YYYY-MM-DD' });
  }
  return reply.code(201).send(createEntry({ date: body.date, content: body.content }));
});

app.patch('/api/entries/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: '非法 ID' });
  const body = req.body as Partial<EntryUpdateInput>;
  if (body.date !== undefined && !DATE_RE.test(body.date)) {
    return reply.code(400).send({ error: '日期格式应为 YYYY-MM-DD' });
  }
  if (body.content !== undefined && !body.content.trim()) {
    return reply.code(400).send({ error: '内容不能为空' });
  }
  const entry = updateEntry(id, body ?? {});
  if (!entry) return reply.code(404).send({ error: '没有这条日记' });
  return entry;
});

app.delete('/api/entries/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!UUID_RE.test(id)) return reply.code(400).send({ error: '非法 ID' });
  if (!deleteEntry(id)) return reply.code(404).send({ error: '没有这条日记' });
  return { ok: true };
});

// ---------- 搜索 ----------
app.get('/api/search', async (req) => {
  const q = (req.query as { q?: string }).q;
  if (typeof q !== 'string' || !q.trim()) return [];
  return searchEntries(q.trim());
});

// ---------- 多端同步(增量,端到端加密) ----------
// 请求/响应的增量数据用"同步密钥"AES-GCM 加密(仅两台设备能解);支持旧版明文(兼容)。
interface SyncBody {
  since?: string;
  entries?: Entry[];
  images?: Array<{ id?: string; dataUrl?: string }>;
  localImageIds?: string[];
}

function getSyncKey(): string {
  const fp = path.join(config.dataDir, 'synckey');
  if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf8').trim();
  const k = generateSyncKey();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(fp, k);
  return k;
}

app.post('/api/sync', async (req, reply) => {
  const raw = req.body as { enc?: { iv: string; data: string } } | SyncBody | null;
  const key = getSyncKey();
  const encrypted = Boolean(raw && (raw as { enc?: unknown }).enc);
  let body: SyncBody | null;
  if (encrypted) {
    try {
      body = await decryptObject<SyncBody>(key, (raw as { enc: { iv: string; data: string } }).enc);
    } catch {
      return reply.code(401).send({ error: '同步密钥不匹配' });
    }
  } else {
    body = raw as SyncBody;
  }

  const entries = body?.entries;
  if (!Array.isArray(entries) || entries.length > 100000) {
    return reply.code(400).send({ error: '无效的同步负载' });
  }
  const since = typeof body?.since === 'string' && body.since ? body.since : '';
  const applied = applySyncedEntries(entries);

  // 存入对方送来的图片(按内容哈希,幂等去重)
  for (const img of body?.images ?? []) {
    if (!img || typeof img.dataUrl !== 'string') continue;
    const decoded = decodeImageDataUrl(img.dataUrl);
    if (!decoded) continue;
    const id = img.id && /^[0-9a-f]{16,64}$/.test(img.id) ? img.id : imageIdFromDataUrl(img.dataUrl);
    saveImage(config.imagesDir, id, decoded.bytes);
  }

  // 返回本机有、但对方没有的图片(逐次补齐,已拥有的不再重复传)
  const have = new Set<string>(body?.localImageIds ?? []);
  const missing = listImageIds(config.imagesDir)
    .filter((id) => !have.has(id))
    .map((id) => {
      const bytes = readImage(config.imagesDir, id);
      return bytes ? { id, dataUrl: `data:${detectImageMime(bytes)};base64,${bytes.toString('base64')}` } : null;
    })
    .filter(Boolean);

  // 只返回对方上次同步(since)之后有改动的增量条目(含墓碑);归一化旧引用
  const syncedEntries = getAllEntriesForSync()
    .filter((e) => !since || e.updatedAt > since)
    .map((e) => ({
      ...e,
      content: normalizeLegacyImageRefs(e.content, config.imagesDir, config.uploadsDir),
    }));

  const result = { applied, entries: syncedEntries, images: missing };
  return encrypted ? { enc: await encryptObject(key, result) } : result;
});

// ---------- 扫码配对:给出本机局域网地址的二维码与文本 ----------
function lanBaseUrl(): string {
  const port = config.port;
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) return `http://${n.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

app.get('/api/qr', async (_req, reply) => {
  const url = lanBaseUrl();
  const key = getSyncKey();
  const qrStr = `${url}\n${key}`;
  const dataUrl = await QRCode.toDataURL(qrStr, { margin: 1, width: 360 });
  return { url, dataUrl, key };
});

// ---------- 月度小结 ----------
app.get('/api/summary', async (req, reply) => {
  const month = (req.query as { month?: string }).month;
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    return reply.code(400).send({ error: '月份格式应为 YYYY-MM' });
  }
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const entries = listEntriesByMonth(month);
  if (entries.length === 0) {
    return reply.code(404).send({ error: '这个月还没有日记,先去写一点吧' });
  }
  const cached = getSummary(year, mon);
  if (!cached) return { exists: false };
  const stale = cached.entriesHash !== entriesHash(entries);
  return { exists: true, stale, summary: cached };
});

app.post('/api/summary', async (req, reply) => {
  const month = (req.body as { month?: string })?.month;
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    return reply.code(400).send({ error: '月份格式应为 YYYY-MM' });
  }
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const entries = listEntriesByMonth(month);
  if (entries.length === 0) {
    return reply.code(404).send({ error: '这个月还没有日记,先去写一点吧' });
  }
  const hasImages = entriesContainImages(entries);
  const provider = hasImages ? getVisionProvider() : getTextProvider();
  const content = await summarizeMonth(entries, provider, config.imagesDir, config.uploadsDir);
  const summary = upsertSummary(year, mon, content, entriesHash(entries));
  return { summary, model: hasImages ? config.ai.visionModel : config.ai.textModel };
});

// ---------- 公共能力:AI 小结(自包含、可独立部署/上云) ----------
// 客户端把"当月日记"发来,服务端用自身 AI 密钥生成小结并返回。不依赖本库,可部署到任意服务器。
app.post('/api/summarize', async (req, reply) => {
  const raw = req.body as { enc?: { iv: string; data: string } } | { entries?: Entry[] } | null;
  const key = getSyncKey();
  const encrypted = Boolean(raw && (raw as { enc?: unknown }).enc);
  let body: { entries?: Entry[] };
  if (encrypted) {
    try {
      body = await decryptObject<{ entries?: Entry[] }>(key, (raw as { enc: { iv: string; data: string } }).enc);
    } catch {
      return reply.code(401).send({ error: '同步密钥不匹配' });
    }
  } else {
    body = raw as { entries?: Entry[] };
  }
  const entries = body?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return reply.code(400).send({ error: '没有可小结的日记' });
  }
  const hasImages = entriesContainImages(entries);
  const provider = hasImages ? getVisionProvider() : getTextProvider();
  const content = await summarizeMonth(entries, provider, config.imagesDir, config.uploadsDir);
  const result = { content, model: hasImages ? config.ai.visionModel : config.ai.textModel };
  return encrypted ? { enc: await encryptObject(key, result) } : result;
});

// ---------- 导出 ----------
function buildMarkdownExport(entries: Awaited<ReturnType<typeof listAllEntries>>): string {
  const byDate = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }
  const lines: string[] = ['# 我的日记', ''];
  for (const date of [...byDate.keys()].sort()) {
    lines.push(`## ${date}`, '');
    for (const e of byDate.get(date)!) {
      lines.push(e.content.trim(), '');
    }
    lines.push('---', '');
  }
  return lines.join('\n');
}

app.get('/api/export', async (req, reply) => {
  const format = (req.query as { format?: string }).format ?? 'md';
  const entries = listAllEntries();
  const date = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="diary-export-${date}.json"`);
    return JSON.stringify(entries, null, 2);
  }
  reply.header('Content-Type', 'text/markdown; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="diary-export-${date}.md"`);
  return buildMarkdownExport(entries);
});

// ---------- 图片 ----------
const IMAGE_DATA_RE = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

app.post('/api/uploads', async (req, reply) => {
  const dataUrl = (req.body as { dataUrl?: string } | null)?.dataUrl;
  if (typeof dataUrl !== 'string') {
    return reply.code(400).send({ error: '缺少图片数据' });
  }
  const m = IMAGE_DATA_RE.exec(dataUrl);
  if (!m) return reply.code(400).send({ error: '仅支持 PNG / JPEG / GIF / WebP 图片' });
  const mime = m[1]!;
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]!;
  const buf = Buffer.from(m[2]!, 'base64');
  if (buf.length === 0) return reply.code(400).send({ error: '图片数据为空' });
  if (buf.length > 32 * 1024 * 1024) return reply.code(413).send({ error: '图片过大(最大 32MB)' });

  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const name = `img-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  fs.writeFileSync(path.join(config.uploadsDir, name), buf);
  return reply.code(201).send({ url: `/api/uploads/${name}` });
});

app.get('/api/uploads/:name', async (req, reply) => {
  const name = path.basename((req.params as { name: string }).name);
  if (!/^img-[A-Za-z0-9-]+\.(png|jpe?g|gif|webp)$/.test(name)) {
    return reply.code(404).send({ error: '图片不存在' });
  }
  const fp = path.join(config.uploadsDir, name);
  if (!fs.existsSync(fp)) return reply.code(404).send({ error: '图片不存在' });
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return reply.type(mime).send(fs.readFileSync(fp));
});

// ---------- 内容寻址图片(统一模型) ----------
// 上传:按内容哈希(id)去重存储;条目内引用 diary-img:<id>
app.post('/api/images', async (req, reply) => {
  const dataUrl = (req.body as { dataUrl?: string } | null)?.dataUrl;
  if (typeof dataUrl !== 'string') return reply.code(400).send({ error: '缺少图片数据' });
  const decoded = decodeImageDataUrl(dataUrl);
  if (!decoded) return reply.code(400).send({ error: '仅支持 PNG / JPEG / GIF / WebP 图片' });
  if (decoded.bytes.length > 32 * 1024 * 1024) return reply.code(413).send({ error: '图片过大(最大 32MB)' });

  const id = imageIdFromDataUrl(dataUrl);
  saveImage(config.imagesDir, id, decoded.bytes);
  return reply.code(201).send({ id });
});

app.get('/api/images/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!/^[0-9a-f]{16,64}$/.test(id)) return reply.code(404).send({ error: '图片不存在' });
  const bytes = readImage(config.imagesDir, id);
  if (!bytes) return reply.code(404).send({ error: '图片不存在' });
  return reply.type(detectImageMime(bytes)).send(bytes);
});

// ---------- 静态托管(生产模式:把构建好的前端一并伺服) ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((_req, reply) => {
    // SPA 回退到 index.html
    return reply.sendFile('index.html');
  });
}

// ---------- 启动 ----------
const start = async () => {
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`日记服务已启动: http://localhost:${config.port}`);
    app.log.info(`数据目录: ${config.dataDir}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
