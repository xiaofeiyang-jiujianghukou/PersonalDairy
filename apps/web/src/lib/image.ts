import { isPhoneMode } from '../api';
import { getFetch } from './net';
import { getImage, listImageIds, putImage } from './localStore';
import { detectImageMime, makeDiaryImgRef, makeDiaryVideoRef } from '@diary/shared/images';

/** 计算图片内容哈希 id(sha256 十六进制,与服务端一致)。 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('读取图片失败'));
    r.readAsDataURL(file);
  });
}

/**
 * 把图片转为统一引用 `diary-img:<内容哈希>`:
 * - 手机本地优先:按内容哈希存入 IndexedDB 图片库;
 * - 远端:上传到服务器 /api/images(服务器按哈希去重),返回引用。
 */
export async function uploadImage(file: File): Promise<string> {
  if (isPhoneMode()) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = await sha256Hex(bytes);
    await putImage(id, file);
    return makeDiaryImgRef(id);
  }
  const dataUrl = await fileToDataUrl(file);
  const res = await (await getFetch())('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `上传失败 (${res.status})`);
  }
  const data = (await res.json()) as { id: string };
  return makeDiaryImgRef(data.id);
}

/** 是否视频文件(按 MIME 前缀)。 */
export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/');
}

/**
 * 把视频统一为引用 `diary-video:<内容哈希>`:
 * - 手机本地优先:按内容哈希存入 IndexedDB 媒体库;
 * - 远端:上传到服务器 /api/media,返回引用。
 */
export async function uploadVideo(file: File): Promise<string> {
  if (isPhoneMode()) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = await sha256Hex(bytes);
    await putImage(id, file);
    return makeDiaryVideoRef(id);
  }
  const dataUrl = await fileToDataUrl(file);
  const res = await (await getFetch())('/api/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `上传失败 (${res.status})`);
  }
  const data = (await res.json()) as { id: string };
  return makeDiaryVideoRef(data.id);
}

/** 按文件类型分发:视频走 uploadVideo,图片走 uploadImage。 */
export async function uploadMedia(file: File): Promise<string> {
  return isVideoFile(file) ? uploadVideo(file) : uploadImage(file);
}

/**
 * 把视频引用解析成可播放 URL(blob/data URL 或原样)。
 * 调用方负责 revoke 返回的 object URL。
 */
export async function resolveVideoRef(ref: string): Promise<string> {
  if (ref.startsWith('diary-video:')) {
    const id = ref.slice('diary-video:'.length);
    if (isPhoneMode()) {
      const blob = await getImage(id);
      return blob ? URL.createObjectURL(blob) : '';
    }
    const res = await (await getFetch())(`/api/media/${id}`);
    if (!res.ok) return '';
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }
  return ref;
}

/** 按引用前缀分发:diary-video → 视频,diary-img/其它 → 图片。 */
export async function resolveMediaRef(ref: string): Promise<string> {
  return ref.startsWith('diary-video:') ? resolveVideoRef(ref) : resolveImageRef(ref);
}

/**
 * 把图片引用解析成可显示的 URL(blob/data URL 或原样)。
 * 调用方负责 revoke 返回的 object URL。
 */
export async function resolveImageRef(ref: string): Promise<string> {
  if (ref.startsWith('diary-img:')) {
    const id = ref.slice('diary-img:'.length);
    if (isPhoneMode()) {
      const blob = await getImage(id);
      return blob ? URL.createObjectURL(blob) : '';
    }
    const res = await (await getFetch())(`/api/images/${id}`);
    if (!res.ok) return '';
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }
  if (ref.startsWith('/api/uploads/')) return isPhoneMode() ? '' : ref; // 旧式服务器文件:远端原样,本地无
  return ref; // http / data URL 原样
}

/** Markdown 安全协议允许列表:放行 data/blob/图片与视频引用。 */
const URL_SAFE = /^(https?|data|blob|diary-img|diary-video)$/i;

export function allowImageUrlTransform(value: string): string {
  const url = value.trim();
  const idx = url.indexOf(':');
  if (idx > 0) {
    const protocol = url.slice(0, idx);
    if (!URL_SAFE.test(protocol)) return '';
  }
  return url;
}

/** 按 id 导出图片(供同步推送增量引用到的图)。 */
export async function exportImagesFor(ids: string[]): Promise<Array<{ id: string; dataUrl: string }>> {
  const out: Array<{ id: string; dataUrl: string }> = [];
  for (const id of ids) {
    const blob = await getImage(id);
    if (blob) out.push({ id, dataUrl: await blobToDataUrl(blob) });
  }
  return out;
}

/** 按 id 导出媒体(图片 + 视频,同一内容寻址库)。 */
export async function exportMediaFor(ids: string[]): Promise<Array<{ id: string; dataUrl: string }>> {
  return exportImagesFor(ids);
}

/** 把本机图片库导出为 {id,dataUrl} 列表(供同步推送)。 */
export async function exportLocalImages(): Promise<Array<{ id: string; dataUrl: string }>> {
  const ids = await listImageIds();
  const out: Array<{ id: string; dataUrl: string }> = [];
  for (const id of ids) {
    const blob = await getImage(id);
    if (blob) out.push({ id, dataUrl: await blobToDataUrl(blob) });
  }
  return out;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('读取图片失败'));
    r.readAsDataURL(blob);
  });
}

/** 把 dataURL 写入本机图片库(供同步拉取存回)。 */
export async function importImageDataUrl(dataUrl: string): Promise<string> {
  const res = await fetch(dataUrl); // data: URL,浏览器 fetch 即可(无 CORS)
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const id = await sha256Hex(bytes);
  await putImage(id, blob);
  return id;
}

/**
 * 归一化旧式 /api/uploads/<name> 引用 → diary-img:<哈希>:
 * 通过 partner 拉取图片字节,按内容哈希存入本机图片库,并重写引用。
 * 拉取失败或无文件则保留原样。
 */
export async function normalizeUploadRefs(content: string, baseUrl: string): Promise<string> {
  const re = /!\[[^\]]*\]\((\/api\/uploads\/[^)]+)\)/g;
  let m: RegExpExecArray | null;
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  while ((m = re.exec(content)) !== null) {
    out += content.slice(last, m.index);
    const ref = m[1]!;
    let replaced = false;
    try {
      const res = await (await getFetch())(`${baseUrl}${ref}`);
      if (res.ok) {
        const blob = await res.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const id = await sha256Hex(bytes);
        await putImage(id, blob);
        out += `![图片](${makeDiaryImgRef(id)})`;
        replaced = true;
      }
    } catch {
      /* ignore */
    }
    if (!replaced) out += m[0];
    last = m.index + m[0].length;
  }
  out += content.slice(last);
  return out;
}

export { detectImageMime };
