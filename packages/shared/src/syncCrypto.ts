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

/**
 * 由"账号种子(uid)"+ 口令 确定性派生同一把同步密钥(hex)。
 * 效果:同一账号同一密码登录的所有设备都派生同一把密钥 → 重装后"登录即恢复",
 * 无需重新扫码配对;密钥只在本机由口令派生,服务端从不持有(隐私不破)。
 * salt 是账号恒定值(非机密),PBKDF2 150k 派生;
 * 换密码会得到新密钥(需重新登录收敛),这与"忘记密码=重新开始"一致。
 */
export async function deriveSyncKey(password: string, seed: string): Promise<string> {
  const salt = te.encode(`personal-diary-sync-v1:${seed}`);
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 150_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true, // 可导出为原始字节,再转 hex 字符串
    ['encrypt', 'decrypt'],
  );
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  return [...new Uint8Array(raw)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- 口令加密(迁移包/备份文件专用,与同步密钥无关) ----------
// 用用户口令 + 随机盐走 PBKDF2 派生 AES-256 密钥,再 AES-GCM 加密负载。
// 这样迁移包即使被他人拿到,没有口令也只是一串密文。
const PBKDF2_ITERATIONS = 150_000;

async function importKeyPbkdf2(passphrase: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
}

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await importKeyPbkdf2(passphrase);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface PassEncPayload {
  kdf: { salt: string; iterations: number };
  iv: string;
  data: string;
}

/** 用口令加密对象,返回 { kdf, iv, data }。 */
export async function encryptObjectWithPassphrase(passphrase: string, obj: unknown): Promise<PassEncPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt);
  const data = te.encode(JSON.stringify(obj));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource),
  );
  return { kdf: { salt: b64(salt), iterations: PBKDF2_ITERATIONS }, iv: b64(iv), data: b64(ct) };
}

/** 用口令解密 { kdf, iv, data } 为对象(含认证,口令错误会抛错)。 */
export async function decryptObjectWithPassphrase<T>(passphrase: string, enc: PassEncPayload): Promise<T> {
  const salt = b64bytes(enc.kdf.salt);
  const key = await deriveAesKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64bytes(enc.iv) as BufferSource },
    key,
    b64bytes(enc.data) as BufferSource,
  );
  return JSON.parse(td.decode(pt)) as T;
}
