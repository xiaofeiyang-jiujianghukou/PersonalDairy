import type {
  Entry,
  EntryCreateInput,
  EntryUpdateInput,
  MonthSummary,
  SearchResult,
  SummaryReadResult,
} from '@diary/shared';
import { reconcileFull } from '@diary/shared/sync';
import { extractDiaryImgRefs } from '@diary/shared/images';
import { decryptObject, encryptObject } from '@diary/shared/syncCrypto';
import { IdbBackend, createLocalApi, listImageIds, type LocalBackend } from './lib/localStore';
import { exportImagesFor, importImageDataUrl, normalizeUploadRefs } from './lib/image';

// 端点烘焙原则:生产构建用 VITE_API_BASE(固定云服务域,非用户配置);
// 测试阶段可用 localStorage 覆盖(即"服务端地址"设置)。
const bakedApiBase = (import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? '';
const API_BASE_KEY = 'diary.apiBase';
const SYNC_PARTNER_KEY = 'diary.syncPartner';

/** 读取 API 基点:优先烘焙端点(生产固定),测试阶段可被 localStorage 覆盖;留空 = 同源。 */
export function getApiBase(): string {
  const baked = bakedApiBase.replace(/\/+$/, '');
  if (baked) return baked;
  try {
    return (localStorage.getItem(API_BASE_KEY) ?? '').trim().replace(/\/+$/, '');
  } catch {
    return '';
  }
}
/** 设置日记服务器地址(仅"远端连接"模式用)。 */
export function setApiBase(value: string): void {
  try {
    localStorage.setItem(API_BASE_KEY, value.trim());
  } catch {
    /* ignore */
  }
}

/** 读到已配对的电脑地址(本地优先模式,自动同步用)。 */
export function getSyncPartner(): string {
  try {
    return (localStorage.getItem(SYNC_PARTNER_KEY) ?? '').trim().replace(/\/+$/, '');
  } catch {
    return '';
  }
}
export function setSyncPartner(value: string): void {
  try {
    localStorage.setItem(SYNC_PARTNER_KEY, value.trim());
  } catch {
    /* ignore */
  }
}

const LAST_SYNC_KEY = 'diary.lastSyncAt';
/** 读同步水位(上次同步的时间戳;空=未同步)。 */
export function getLastSyncAt(): string {
  try {
    return (localStorage.getItem(LAST_SYNC_KEY) ?? '').trim();
  } catch {
    return '';
  }
}
/** 写同步水位。 */
export function setLastSyncAt(value: string): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, value);
  } catch {
    /* ignore */
  }
}

const SYNC_KEY = 'diary.syncKey';
/** 读同步密钥(扫码配对时从二维码获取)。 */
export function getSyncKey(): string {
  try {
    return (localStorage.getItem(SYNC_KEY) ?? '').trim();
  } catch {
    return '';
  }
}
export function setSyncKey(value: string): void {
  try {
    localStorage.setItem(SYNC_KEY, value.trim());
  } catch {
    /* ignore */
  }
}

/** 运行环境:手机 App(Capacitor)或 桌面壳(Tauri)或本地优先构建 → 数据存本机(IndexedDB)。 */
function isPhoneLocal(): boolean {
  const w = window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
    __TAURI_INTERNALS__?: unknown;
  };
  if (w.Capacitor?.isNativePlatform?.()) return true; // 手机 App
  if (w.__TAURI_INTERNALS__) return true; // Tauri 桌面壳(webview)
  const env = (import.meta as unknown as { env?: { VITE_LOCAL_FIRST?: string } }).env?.VITE_LOCAL_FIRST;
  return env === '1'; // 显式烘焙的本地优先构建(桌面端烘焙时设)
}

/** 对外:当前是否为本地优先模式(数据在本机)。 */
export function isPhoneMode(): boolean {
  return isPhoneLocal();
}

function resolve(url: string): string {
  const base = getApiBase();
  return base ? `${base}${url}` : url;
}

const TOKEN_KEY = 'diary.token';
/** 会话 token(登录后由鉴权接口返回)。 */
export function getToken(): string {
  try {
    return (localStorage.getItem(TOKEN_KEY) ?? '').trim();
  } catch {
    return '';
  }
}
export function setToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t.trim());
  } catch {
    /* ignore */
  }
}
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolve(url), {
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}
async function httpFrom<T>(base: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base || ''}${url}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** 远端(连接电脑/同源 REST)API。 */
const remoteApi = {
  health: () => http<{ ok: boolean; aiConfigured: boolean; textModel: string; visionModel: string; dataDir: string }>('/api/health'),
  listByDate: (date: string) => http<Entry[]>(`/api/entries?date=${date}`),
  listByMonth: (month: string) => http<Entry[]>(`/api/entries?month=${month}`),
  create: (input: EntryCreateInput) => http<Entry>('/api/entries', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: EntryUpdateInput) => http<Entry>(`/api/entries/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: string) => http<{ ok: boolean }>(`/api/entries/${id}`, { method: 'DELETE' }),
  search: (q: string) => http<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),
  summaryRead: (month: string) => http<SummaryReadResult>(`/api/summary?month=${month}`),
  summaryGenerate: (month: string) =>
    http<{ summary: MonthSummary; model: string }>('/api/summary', { method: 'POST', body: JSON.stringify({ month }) }),
};

/** 手机本地优先 API。 */
let backend: LocalBackend | null = null;
function getLocalBackend(): LocalBackend {
  if (!backend) backend = new IdbBackend();
  return backend;
}
const localApi = createLocalApi(getLocalBackend());

// 手机本地优先:AI 月度小结委托给配对的电脑(/api/summarize,端到端加密)——公共能力在服务端,可上云
function entriesHashSimple(entries: Entry[]): string {
  const s = entries.map((e) => `${e.id}|${e.updatedAt}|${e.content}`).join('\n');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
(localApi as unknown as { summaryGenerate: unknown }).summaryGenerate = async (month: string) => {
  const all = await getLocalBackend().getAll();
  const entries = all.filter((e) => e.date.startsWith(month) && !e.deletedAt);
  if (entries.length === 0) throw new Error('这个月还没有日记');

  // 有云端服务(base,如 https://bluesheep.vip)时走云端 /api/summarize(AI 公共能力、不落盘);
  if (getApiBase()) {
    const res = await http<{ content: string; model: string }>('/api/summarize', {
      method: 'POST',
      body: JSON.stringify({ month, entries }),
    });
    return {
      summary: {
        year: Number(month.slice(0, 4)),
        month: Number(month.slice(5, 7)),
        content: res.content,
        entriesHash: entriesHashSimple(entries),
        createdAt: new Date().toISOString(),
      },
      model: res.model,
    };
  }

  // 无云端:委托配对的本地电脑(端到端加密)
  const partner = getSyncPartner();
  if (!partner) throw new Error('尚未配对电脑,无法生成小结');
  const syncKey = getSyncKey();
  const payload = { month, entries };
  const raw = await httpFrom<
    { enc: { iv: string; data: string } } | { content: string; model: string }
  >(partner, '/api/summarize', {
    method: 'POST',
    body: JSON.stringify(syncKey ? { enc: await encryptObject(syncKey, payload) } : payload),
  });
  const res = syncKey
    ? await decryptObject<{ content: string; model: string }>(syncKey, (raw as { enc: { iv: string; data: string } }).enc)
    : (raw as { content: string; model: string });
  return {
    summary: {
      year: Number(month.slice(0, 4)),
      month: Number(month.slice(5, 7)),
      content: res.content,
      entriesHash: entriesHashSimple(entries),
      createdAt: new Date().toISOString(),
    },
    model: res.model,
  };
};

/** 供 UI 使用的统一 API(桌面=远端,手机 App=本地)。 */
export const api = isPhoneLocal() ? (localApi as unknown as typeof remoteApi) : remoteApi;

/** 陪伴对话消息。 */
export interface CompanionMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * AI 陪伴对话(公共能力,与 AI 小结同构):
 * - 有云端服务(base):本地优先设备直接把"对话+背景"发云端 /api/companion(AI 公共能力、不落盘);
 * - 无云端:手机本地优先委托配对的电脑(端到端加密);电脑本机走服务端。
 */
async function companionLocal(messages: CompanionMessage[], context: Entry[]): Promise<{ reply: string; model: string }> {
  const partner = getSyncPartner();
  if (!partner) throw new Error('尚未配对电脑,无法使用 AI 陪伴');
  const syncKey = getSyncKey();
  const payload = { messages, context };
  const raw = await httpFrom<{ enc: { iv: string; data: string } } | { reply: string; model: string }>(
    partner,
    '/api/companion',
    { method: 'POST', body: JSON.stringify(syncKey ? { enc: await encryptObject(syncKey, payload) } : payload) },
  );
  return syncKey
    ? decryptObject<{ reply: string; model: string }>(syncKey, (raw as { enc: { iv: string; data: string } }).enc)
    : (raw as { reply: string; model: string });
}

export const companionApi = {
  chat: (messages: CompanionMessage[], context: Entry[]): Promise<{ reply: string; model: string }> => {
    // 已配置云端(base)时,本地优先也直接走云端(内容只在 AI 处理时短暂经过,不落盘)
    if (getApiBase()) {
      return http<{ reply: string; model: string }>('/api/companion', {
        method: 'POST',
        body: JSON.stringify({ messages, context }),
      });
    }
    return isPhoneLocal() ? companionLocal(messages, context) : http<{ reply: string; model: string }>('/api/companion', {
      method: 'POST',
      body: JSON.stringify({ messages, context }),
    });
  },
};

/** 账号鉴权(始终走服务端,与本地优先无关)。 */
export const authApi = {
  register: (username: string, password: string) =>
    http<{ token: string; username: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    http<{ token: string; username: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () => http<{ username: string }>('/api/auth/me'),
  logout: () => http<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  // 微信式扫码登录
  loginQr: () => http<{ qrId: string; dataUrl: string }>('/api/auth/login-qr', { method: 'POST' }),
  loginQrPoll: (qrId: string) =>
    http<{ status: 'pending' | 'confirmed'; token?: string; username?: string }>(
      `/api/auth/login-qr/${qrId}`,
    ),
  scanConfirm: (qrId: string) =>
    http<{ ok: boolean }>('/api/auth/scan-confirm', { method: 'POST', body: JSON.stringify({ qrId }) }),
};

/** 导出下载地址(远端模式带基址;本地模式返回 '' 表示不支持)。 */
export function exportUrl(): string {
  return isPhoneLocal() ? '' : resolve('/api/export');
}

/**
 * 本地优先同步(增量):只交换自上次同步(since)以来有改动的条目与图片,避免全量重传。
 * 数据越多越省:单次同步只传"这次改动",而非整年历史。
 */
export async function syncNow(): Promise<{ applied: number; pulled: number; partner: string }> {
  const partner = getSyncPartner();
  if (!partner) throw new Error('尚未配对电脑');
  if (!isPhoneLocal()) throw new Error('仅本地模式支持同步');

  let since = getLastSyncAt();
  // 自愈:若水位是"将来时间"(被将来时间戳/时钟偏差污染),重置为全量同步,避免新条目被跳过
  if (since && since > new Date().toISOString()) since = '';
  const ours = await getLocalBackend().getAll(); // 含墓碑
  const delta = ours.filter((e) => !since || e.updatedAt > since); // 增量条目

  // 只推送增量条目引用到的图片
  const deltaImgIds = new Set<string>();
  for (const e of delta) for (const id of extractDiaryImgRefs(e.content)) deltaImgIds.add(id);
  const pushImages = await exportImagesFor([...deltaImgIds]);
  const localImageIds = await listImageIds(); // 本机全部图片 id,让服务端只补缺失的

  const syncKey = getSyncKey();
  const payload = { since, entries: delta, images: pushImages, localImageIds };

  // 有同步密钥(扫码配对获得)则端到端加密;否则明文(兼容)
  let res: { applied?: number; entries: Entry[]; images?: Array<{ id: string; dataUrl: string }> };
  if (syncKey) {
    const enc = await encryptObject(syncKey, payload);
    const r = await httpFrom<{ enc: { iv: string; data: string } }>(partner, '/api/sync', {
      method: 'POST',
      body: JSON.stringify({ enc }),
    });
    res = await decryptObject<{ applied?: number; entries: Entry[]; images?: Array<{ id: string; dataUrl: string }> }>(syncKey, r.enc);
  } else {
    res = await httpFrom<{ applied?: number; entries: Entry[]; images?: Array<{ id: string; dataUrl: string }> }>(
      partner,
      '/api/sync',
      { method: 'POST', body: JSON.stringify(payload) },
    );
  }

  // 拉取服务端缺失的图片
  for (const img of res.images ?? []) if (img?.dataUrl) await importImageDataUrl(img.dataUrl);

  const theirs: Entry[] = res.entries ?? [];
  const reconciled = reconcileFull(ours, theirs);
  const localMap = new Map(ours.map((e) => [e.id, e]));
  const toWrite: Entry[] = [];
  for (const e of reconciled) {
    const cur = localMap.get(e.id);
    if (!cur || e.updatedAt > cur.updatedAt) toWrite.push(e);
  }
  await getLocalBackend().put(toWrite);

  // 归一化残留旧引用
  const allLocal = await getLocalBackend().getAll();
  const legacy = allLocal.filter((e) => /\/api\/uploads\//.test(e.content));
  if (legacy.length) {
    await Promise.all(
      legacy.map(async (e) => {
        e.content = await normalizeUploadRefs(e.content, partner);
      }),
    );
    await getLocalBackend().put(legacy);
  }

  // 推进同步水位:用"本次同步时刻"(手机自己的时钟),避免被服务端未来时间戳/时钟偏差污染,
  // 从而保证之后新写的条目(时间戳 > 水位)始终会被当作增量推送。
  setLastSyncAt(new Date().toISOString());

  return { applied: res.applied ?? 0, pulled: toWrite.length, partner };
}

const DEVICE_ID_KEY = 'diary.deviceId';
function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY) ?? '';
    if (!id) {
      id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'anon';
  }
}

/**
 * 继电器同步(P2,跨网络):把加密增量推到中继,并取走对端推送的,解密后 LWW 合并。
 * 不依赖 P2P 可达性;只要客户端能访问服务端(/api/relay)即可。
 */
export async function relaySyncNow(): Promise<{ pulled: number }> {
  const syncKey = getSyncKey();
  if (!syncKey) throw new Error('尚未配对(无同步密钥)');
  const since = getLastSyncAt();
  const ours = await getLocalBackend().getAll();
  const delta = ours.filter((e) => !since || e.updatedAt > since);
  const deltaImgIds = new Set<string>();
  for (const e of delta) for (const id of extractDiaryImgRefs(e.content)) deltaImgIds.add(id);
  const pushImages = await exportImagesFor([...deltaImgIds]);
  const localImageIds = await listImageIds();
  const deviceId = getDeviceId();
  const payload = { since, entries: delta, images: pushImages, localImageIds };
  const enc = await encryptObject(syncKey, payload);
  await http<{ ok: boolean }>('/api/relay/push', {
    method: 'POST',
    body: JSON.stringify({ from: deviceId, payload: JSON.stringify(enc) }),
  });

  const pull = await http<{ messages: Array<{ from: string; payload: string }> }>(
    `/api/relay/pull?from=${encodeURIComponent(deviceId)}`,
  );
  let pulled = 0;
  for (const m of pull.messages) {
    const peer = await decryptObject<{
      entries: Entry[];
      images?: Array<{ id: string; dataUrl: string }>;
    }>(syncKey, JSON.parse(m.payload));
    for (const img of peer.images ?? []) if (img?.dataUrl) await importImageDataUrl(img.dataUrl);
    const reconciled = reconcileFull(ours, peer.entries ?? []);
    const localMap = new Map(ours.map((e) => [e.id, e]));
    const toWrite: Entry[] = [];
    for (const e of reconciled) {
      const cur = localMap.get(e.id);
      if (!cur || e.updatedAt > cur.updatedAt) toWrite.push(e);
    }
    if (toWrite.length) {
      await getLocalBackend().put(toWrite);
      pulled += toWrite.length;
    }
  }
  setLastSyncAt(new Date().toISOString());
  return { pulled };
}

/** 测试辅助。 */
export const _apiTest = { isPhoneLocal, getLocalBackend };
