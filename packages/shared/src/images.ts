/**
 * 图片统一模型(内容寻址):
 * - 图片以内容哈希(SHA-256)作为唯一 id;
 * - 条目内只存短引用 diary-img:<id>,不内嵌大 base64;
 * - 图片字节单独存(电脑:磁盘文件;手机:IndexedDB blob),同步按 id 一起传。
 */

export const DIARY_IMG_PREFIX = 'diary-img:';

/** 引用格式:![图片](diary-img:<sha256>) */
export const DIARY_IMG_RE = /!\[[^\]]*\]\(diary-img:([0-9a-f]{16,64})\)/g;

/** 从正文中抽取所有 diary-img 图片 id。 */
export function extractDiaryImgRefs(content: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  DIARY_IMG_RE.lastIndex = 0;
  while ((m = DIARY_IMG_RE.exec(content)) !== null) out.push(m[1]!);
  return out;
}

/** 生成日记图片引用。 */
export function makeDiaryImgRef(id: string): string {
  return `${DIARY_IMG_PREFIX}${id}`;
}

/** 校验图片 id(sha256 十六进制,16-64 位)。 */
export function isValidImageId(id: string): boolean {
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
