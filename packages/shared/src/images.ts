/**
 * 图片/视频统一模型(内容寻址):
 * - 媒体以内容哈希(SHA-256)作为唯一 id;
 * - 条目内只存短引用 diary-img:<id> / diary-video:<id>,不内嵌大 base64;
 * - 媒体字节单独存(电脑:磁盘文件;手机:IndexedDB blob),同步按 id 一起传。
 */

export const DIARY_IMG_PREFIX = 'diary-img:';
export const DIARY_VIDEO_PREFIX = 'diary-video:';

/** 引用格式:![图片](diary-img:<sha256>) */
export const DIARY_IMG_RE = /!\[[^\]]*\]\(diary-img:([0-9a-f]{16,64})\)/g;
/** 引用格式:![视频](diary-video:<sha256>) */
export const DIARY_VIDEO_RE = /!\[[^\]]*\]\(diary-video:([0-9a-f]{16,64})\)/g;

/** 从正文中抽取所有 diary-img 图片 id。 */
export function extractDiaryImgRefs(content: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  DIARY_IMG_RE.lastIndex = 0;
  while ((m = DIARY_IMG_RE.exec(content)) !== null) out.push(m[1]!);
  return out;
}

/** 从正文中抽取所有 diary-video 视频 id。 */
export function extractDiaryVideoRefs(content: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  DIARY_VIDEO_RE.lastIndex = 0;
  while ((m = DIARY_VIDEO_RE.exec(content)) !== null) out.push(m[1]!);
  return out;
}

/** 从正文中抽取所有媒体 id(图片 + 视频)。 */
export function extractMediaIds(content: string): string[] {
  return [...extractDiaryImgRefs(content), ...extractDiaryVideoRefs(content)];
}

/** 生成日记图片引用。 */
export function makeDiaryImgRef(id: string): string {
  return `${DIARY_IMG_PREFIX}${id}`;
}
/** 生成日记视频引用。 */
export function makeDiaryVideoRef(id: string): string {
  return `${DIARY_VIDEO_PREFIX}${id}`;
}

/** 校验图片 id(sha256 十六进制,16-64 位)。 */
export function isValidImageId(id: string): boolean {
  return /^[0-9a-f]{16,64}$/.test(id);
}
/** 校验视频 id(sha256 十六进制,16-64 位)。 */
export function isValidVideoId(id: string): boolean {
  return /^[0-9a-f]{16,64}$/.test(id);
}

/** 由图片字节探测 MIME(依据 magic number,两端通用)。 */
export function detectImageMime(bytes: Uint8Array): string {
  if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  return 'image/png';
}

/** 由视频字节探测 MIME(mp4/webm/mov 等,依据 magic number)。 */
export function detectVideoMime(bytes: Uint8Array): string {
  // MP4 / MOV / M4V:offset 4 处为 'ftyp'
  if (bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video/mp4';
  // WebM / MKV:EBML 头部 1A 45 DF A3
  if (bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  // 其它:兜底 mp4
  return 'video/mp4';
}

/** 由字节探测媒体类型(图片则返回 image/*,视频则 video/*)。 */
export function detectMediaMime(bytes: Uint8Array): string {
  if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return detectImageMime(bytes);
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return detectImageMime(bytes);
  if (bytes.length > 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return detectImageMime(bytes);
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return detectImageMime(bytes);
  return detectVideoMime(bytes);
}
