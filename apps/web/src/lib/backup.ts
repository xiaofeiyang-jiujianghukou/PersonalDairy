import type { Entry } from '@diary/shared';
import { reconcileFull } from '@diary/shared/sync';
import {
  assertBundle,
  isEncryptedBundle,
  type BundleEnvelope,
  type BundleFile,
} from '@diary/shared/bundle';
import { decryptObjectWithPassphrase, encryptObjectWithPassphrase } from '@diary/shared/syncCrypto';
import { _apiTest, getApiBase, getToken } from '../api';
import { exportLocalImages } from './image';
import { putImage as putImageInStore, listImageIds } from './localStore';

const getLocalBackend = _apiTest.getLocalBackend;
const isRemote = () => !_apiTest.isPhoneLocal();

/** 把 dataURL 解码成 Blob。 */
function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',');
  const mime = /data:([^;]+);/.exec(head ?? '')?.[1] ?? 'application/octet-stream';
  const bin = atob(body ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * 纯函数:计算要从迁移包写入本机的条目(仅写"本机没有 / 更新"的,LWW)。
 * 与同步合并逻辑同源(都用 reconcileFull + updatedAt 取新),保证多端一致。
 */
export function computeImportTouches(ours: Entry[], incoming: Entry[]): Entry[] {
  const reconciled = reconcileFull(ours, incoming);
  const map = new Map(ours.map((e) => [e.id, e]));
  const toWrite: Entry[] = [];
  for (const e of reconciled) {
    const cur = map.get(e.id);
    if (!cur || e.updatedAt > cur.updatedAt) toWrite.push(e);
  }
  return toWrite;
}

/**
 * 导出当前设备(手机本地优先)的全部日记+图片为迁移包。
 * @param passphrase 空串 = 明文文件;非空 = 口令加密(AES-256-GCM,PBKDF2)。
 */
export async function exportLocalToBundle(passphrase: string, deviceId = 'phone'): Promise<BundleEnvelope> {
  const entries = await getLocalBackend().getAll(); // 含墓碑,便于 LWW 忠实合并
  const images = await exportLocalImages();
  const bundle: BundleFile = {
    app: 'diary',
    version: 1,
    createdAt: new Date().toISOString(),
    deviceId,
    entries,
    images,
  };
  if (!passphrase) return bundle;
  const enc = await encryptObjectWithPassphrase(passphrase, bundle);
  return {
    app: 'diary',
    version: 1,
    createdAt: bundle.createdAt,
    deviceId,
    kdf: enc.kdf,
    iv: enc.iv,
    data: enc.data,
  };
}

export interface ImportResult {
  entriesImported: number;
  imagesImported: number;
  fromDeviceId: string;
}

/** 解析迁移包文件(可选口令解密),返回业务负载。 */
export async function parseBundleFile(file: File, passphrase: string): Promise<BundleFile> {
  const text = await file.text();
  let envelope: BundleEnvelope;
  try {
    envelope = assertBundle(JSON.parse(text));
  } catch (err) {
    const msg = err instanceof Error ? err.message : '解析失败';
    throw new Error(`迁移包解析失败:${msg}`);
  }
  if (isEncryptedBundle(envelope)) {
    if (!passphrase) throw new Error('该迁移包已加密,请输入口令');
    const bundle = await decryptObjectWithPassphrase<BundleFile>(passphrase, {
      kdf: envelope.kdf,
      iv: envelope.iv,
      data: envelope.data,
    });
    return assertBundle(bundle) as BundleFile;
  }
  return envelope as BundleFile;
}

/**
 * 把迁移包合并进当前设备(LWW 忠实合并):
 * - 条目:按 updatedAt 取新,墓碑也一并写入;
 * - 图片:按内容寻址 id 写入本机图片库(已存在则跳过)。
 */
export async function importBundleToLocal(file: File, passphrase: string): Promise<ImportResult> {
  const bundle = await parseBundleFile(file, passphrase);
  const ours = await getLocalBackend().getAll(); // 含墓碑
  const toWrite = computeImportTouches(ours, bundle.entries);
  if (toWrite.length) await getLocalBackend().put(toWrite);

  let imagesImported = 0;
  const known = new Set<string>(await listImageIds());
  for (const img of bundle.images) {
    if (known.has(img.id)) continue;
    await putImageInStore(img.id, dataUrlToBlob(img.dataUrl));
    imagesImported++;
  }
  return { entriesImported: toWrite.length, imagesImported, fromDeviceId: bundle.deviceId };
}

/** 按当前模式导出为迁移包(手机=本地,电脑=服务端 /api/export/bundle)。 */
export async function exportCurrentToBundle(passphrase: string, deviceId = 'phone'): Promise<BundleEnvelope> {
  if (!isRemote()) return exportLocalToBundle(passphrase, deviceId);

  // 电脑(远端):下载服务端迁移包(带鉴权),可选口令再加密后落盘
  const res = await fetch(`${getApiBase()}/api/export/bundle`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`下载迁移包失败 (${res.status})`);
  const bundle = (await res.json()) as BundleFile;
  if (!passphrase) return bundle;
  const enc = await encryptObjectWithPassphrase(passphrase, bundle);
  return { app: 'diary', version: 1, createdAt: bundle.createdAt, deviceId, kdf: enc.kdf, iv: enc.iv, data: enc.data };
}

/** 按当前模式导入迁移包(手机=本地合并;电脑=服务端 /api/import/bundle 合并)。 */
export async function importBundleFile(file: File, passphrase: string): Promise<ImportResult> {
  if (!isRemote()) return importBundleToLocal(file, passphrase);

  // 电脑(远端):本地解密(如需要)后把明文负载交给服务端合并
  const bundle = await parseBundleFile(file, passphrase);
  const res = await fetch(`${getApiBase()}/api/import/bundle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(bundle),
  });
  const body = (await res.json().catch(() => null)) as
    | { error?: string; entriesImported?: number; imagesImported?: number }
    | null;
  if (!res.ok) throw new Error(body?.error ?? `导入失败 (${res.status})`);
  return {
    entriesImported: body?.entriesImported ?? 0,
    imagesImported: body?.imagesImported ?? 0,
    fromDeviceId: bundle.deviceId,
  };
}
