import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '@diary/shared';

/** 提取正文中引用的本地图片路径(形如 /api/uploads/xxx)。 */
export function extractImageRefs(content: string): string[] {
  const refs: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const url = (m[1] ?? '').trim();
    if (url.startsWith('/api/uploads/')) refs.push(url);
  }
  return refs;
}

/** 判断这批日记里是否含有本地图片(用于选择视觉 / 文字模型)。 */
export function entriesContainImages(entries: Entry[]): boolean {
  return entries.some((e) => extractImageRefs(e.content).length > 0);
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 把本地图片引用解析为 base64 data URL(用于送给视觉模型);不存在或格式不支持则返回 null。 */
export function imageRefToDataUrl(ref: string, uploadsDir: string): string | null {
  const name = path.basename(ref);
  const fp = path.join(uploadsDir, name);
  if (!fs.existsSync(fp)) return null;
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  const b64 = fs.readFileSync(fp).toString('base64');
  return `data:${mime};base64,${b64}`;
}
