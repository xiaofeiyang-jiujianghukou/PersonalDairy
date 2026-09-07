import type {
  Entry,
  EntryCreateInput,
  EntryUpdateInput,
  MonthSummary,
  SearchResult,
  SummaryReadResult,
} from '@diary/shared';
import { reconcileFull } from '@diary/shared/sync';
import { IdbBackend, createLocalApi, getImage, putImage, type LocalBackend } from './lib/localStore';
import { exportLocalImages, importImageDataUrl } from './lib/image';

const API_BASE_KEY = 'diary.apiBase';
const SYNC_PARTNER_KEY = 'diary.syncPartner';

/** 读取用户配置的日记服务器地址(留空 = 同源,即当前页面自带的日记服务)。 */
export function getApiBase(): string {
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

/** 是否运行在手机 App(Capacitor)里 → 本地优先模式。 */
function isPhoneLocal(): boolean {
  const c = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(c?.isNativePlatform?.());
}

/** 对外:当前是否手机本地优先模式。 */
export function isPhoneMode(): boolean {
  return isPhoneLocal();
}

function resolve(url: string): string {
  const base = getApiBase();
  return base ? `${base}${url}` : url;
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolve(url), { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}
async function httpFrom<T>(base: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base || ''}${url}`, {
    headers: { 'Content-Type': 'application/json' },
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

/** 供 UI 使用的统一 API(桌面=远端,手机 App=本地)。 */
export const api = isPhoneLocal() ? (localApi as unknown as typeof remoteApi) : remoteApi;

/** 导出下载地址(远端模式带基址;本地模式返回 '' 表示不支持)。 */
export function exportUrl(): string {
  return isPhoneLocal() ? '' : resolve('/api/export');
}

/**
 * 本地优先同步:把本机(含墓碑)推给配对的电脑,再拉取对方改动,LWW 合并后写回本机。
 */
export async function syncNow(): Promise<{ applied: number; pulled: number; partner: string }> {
  const partner = getSyncPartner();
  if (!partner) throw new Error('尚未配对电脑');
  if (!isPhoneLocal()) throw new Error('仅本地模式支持同步');

  const ours = await getLocalBackend().getAll(); // 含墓碑
  const ourImages = await exportLocalImages(); // 本机图片库
  const res = await httpFrom<{
    applied?: number;
    entries: Entry[];
    images?: Array<{ id: string; dataUrl: string }>;
  }>(partner, '/api/sync', {
    method: 'POST',
    body: JSON.stringify({
      entries: ours,
      images: ourImages,
      localImageIds: ourImages.map((i) => i.id),
    }),
  });
  // 拉取服务器端缺失的图片,写入本机图片库
  for (const img of res.images ?? []) {
    if (img?.dataUrl) await importImageDataUrl(img.dataUrl);
  }
  const theirs: Entry[] = res.entries ?? [];
  const reconciled = reconcileFull(ours, theirs);
  const localMap = new Map(ours.map((e) => [e.id, e]));
  const toWrite: Entry[] = [];
  for (const e of reconciled) {
    const cur = localMap.get(e.id);
    if (!cur || e.updatedAt > cur.updatedAt) toWrite.push(e);
  }
  await getLocalBackend().put(toWrite);
  return { applied: res.applied ?? 0, pulled: toWrite.length, partner };
}

/** 测试辅助。 */
export const _apiTest = { isPhoneLocal, getLocalBackend };
