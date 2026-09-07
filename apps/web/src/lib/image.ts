import { isPhoneMode } from '../api';

/**
 * 把本地图片文件转成可插入 Markdown 的引用:
 * - 手机本地优先模式:直接作为 data URL 内嵌(自包含、永久可显示,无需服务器);
 * - 远端模式:上传到服务器 /api/uploads,返回其 URL。
 */
export async function uploadImage(file: File): Promise<string> {
  const dataUrl = await fileToDataUrl(file);
  if (isPhoneMode()) return dataUrl; // 本地优先:内嵌,不依赖任何服务器
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `上传失败 (${res.status})`);
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

/** Markdown 安全协议允许列表:允许 http/https/data(本地优先内嵌图)/blob。 */
const URL_SAFE = /^(https?|data|blob)$/i;

/** react-markdown 的 urlTransform:放行 data:/blob: 图片,其余沿用默认安全策略。 */
export function allowImageUrlTransform(value: string): string {
  const url = value.trim();
  const idx = url.indexOf(':');
  if (idx > 0) {
    const protocol = url.slice(0, idx);
    if (!URL_SAFE.test(protocol)) return '';
  }
  return url;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

