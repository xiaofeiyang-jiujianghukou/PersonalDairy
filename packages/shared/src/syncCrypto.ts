/// <reference lib="dom" />
/**
 * 同步负载端到端加密(浏览器与 Node 均可用全局 WebCrypto,格式一致):
 * - 密钥:同步密钥字符串 sha256 后作为 AES-256-GCM 密钥;
 * - 载荷:JSON 序列化后 AES-GCM 加密,输出 { iv, data }(base64);data 为 密文||认证标签。
 * 只有持有同一同步密钥的两端能解密;中途截获只是密文。
 */

const te = new TextEncoder();
const td = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
function b64bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return new Uint8Array(d);
}

async function importKey(keyStr: string): Promise<CryptoKey> {
  const keyBytes = await sha256(te.encode(keyStr));
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface EncPayload {
  iv: string;
  data: string;
}

/** 加密一个对象为 { iv, data }(AES-256-GCM)。 */
export async function encryptObject(keyStr: string, obj: unknown): Promise<EncPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyStr);
  const data = te.encode(JSON.stringify(obj));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource),
  );
  return { iv: b64(iv), data: b64(ct) };
}

/** 解密 { iv, data } 为对象(AES-256-GCM,含认证)。 */
export async function decryptObject<T>(keyStr: string, enc: EncPayload): Promise<T> {
  const key = await importKey(keyStr);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64bytes(enc.iv) as BufferSource },
    key,
    b64bytes(enc.data) as BufferSource,
  );
  return JSON.parse(td.decode(pt)) as T;
}

/** 生成一个随机的同步密钥(hex)。 */
export function generateSyncKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
