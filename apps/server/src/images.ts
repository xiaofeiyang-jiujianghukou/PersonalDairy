import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Entry } from '@diary/shared';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function mimeForExt(ext: string): string {
  return MIME[ext] ?? 'application/octet-stream';
}

/** 由 base64 dataURL 计算内容哈希 id(与客户端一致:sha256 十六进制)。 */
export function imageIdFromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const buf = Buffer.from(b64, 'base64');
  return createHash('sha256').update(buf).digest('hex');
}

/** 解码 dataURL 为图片字节与拓展名(失败返回 null)。 */
export function decodeImageDataUrl(dataUrl: string): { bytes: Buffer; ext: string } | null {
  const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  const mime = m[1]!.toLowerCase();
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]!;
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length === 0) return null;
  return { bytes, ext };
}

/** 保存图片字节到 imagesDir(按内容哈希命名,幂等去重)。 */
export function saveImage(imagesDir: string, id: string, bytes: Buffer): void {
  fs.mkdirSync(imagesDir, { recursive: true });
  const fp = path.join(imagesDir, id);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, bytes);
}

/** 读取图片字节。 */
export function readImage(imagesDir: string, id: string): Buffer | null {
  const fp = path.join(imagesDir, id);
  return fs.existsSync(fp) ? fs.readFileSync(fp) : null;
}

/** 列出磁盘上已有的图片 id(供同步按需拉取)。 */
export function listImageIds(imagesDir: string): string[] {
  if (!fs.existsSync(imagesDir)) return [];
  return fs.readdirSync(imagesDir).filter((f) => /^[0-9a-f]{16,64}$/.test(f));
}

/** 提取正文中的本地图片引用:新式 diary-img:<hash> 与旧式 /api/uploads/xxx。 */
export function extractImageRefs(content: string): string[] {
  const refs: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const url = (m[1] ?? '').trim();
    if (url.startsWith('/api/uploads/') || url.startsWith('diary-img:')) refs.push(url);
  }
  return refs;
}

/** 判断这批日记里是否含有本地图片(用于选择视觉/文字模型)。 */
export function entriesContainImages(entries: Entry[]): boolean {
  return entries.some((e) => extractImageRefs(e.content).length > 0);
}

/**
 * 把本地图片引用解析为 base64 data URL(用于送给视觉模型)。
 * - diary-img:<id>  → imagesDir/<id>
 * - /api/uploads/x  → uploadsDir/<name>(旧式)
 */
export function imageRefToDataUrl(
  ref: string,
  imagesDir: string,
  uploadsDir: string,
): string | null {
  if (ref.startsWith('diary-img:')) {
    const id = ref.slice('diary-img:'.length);
    const bytes = readImage(imagesDir, id);
    if (!bytes) return null;
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }
  if (ref.startsWith('/api/uploads/')) {
    const name = path.basename(ref);
    const fp = path.join(uploadsDir, name);
    if (!fs.existsSync(fp)) return null;
    const ext = path.extname(name).slice(1).toLowerCase();
    const b64 = fs.readFileSync(fp).toString('base64');
    return `data:${mimeForExt(ext)};base64,${b64}`;
  }
  return null;
}
