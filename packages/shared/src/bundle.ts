/**
 * 迁移包(bundle)类型:把某台设备上的全部日记+图片打成单个文件,用于
 * 手机↔手机 迁移或整机备份。文件内容可被口令加密(AES-256-GCM,PBKDF2 派生)。
 *
 * 结构说明:
 * - 明文形式:`BundleFile` —— entries(含墓碑,便于 LWW 忠实合并)+ images(dataURL)。
 * - 加密形式:`EncryptedBundle` —— 与明文同字段,但把 payload 用口令加密后
 *   放 { kdf, iv, data }。只有持有口令者能还原。
 */
import type { Entry } from './index';

export const BUNDLE_APP = 'diary' as const;
export const BUNDLE_VERSION = 1 as const;

/** 迁移包内的单张图片(内容寻址 id + 内嵌 dataURL)。 */
export interface BundleImage {
  id: string;
  dataUrl: string;
}

/** 明文迁移包(未加密,或解密后的业务负载)。 */
export interface BundleFile {
  app: typeof BUNDLE_APP;
  version: typeof BUNDLE_VERSION;
  createdAt: string;
  /** 导出设备的 deviceId(便于识别来源)。 */
  deviceId: string;
  entries: Entry[];
  images: BundleImage[];
}

/** 口令加密的迁移包(外层信封)。 */
export interface EncryptedBundle {
  app: typeof BUNDLE_APP;
  version: typeof BUNDLE_VERSION;
  createdAt: string;
  deviceId: string;
  kdf: { salt: string; iterations: number };
  iv: string;
  data: string;
}

/** 磁盘上的信封:明文或加密二选一。 */
export type BundleEnvelope = BundleFile | EncryptedBundle;

/** 判断信封是否被口令加密。 */
export function isEncryptedBundle(b: BundleEnvelope): b is EncryptedBundle {
  return 'kdf' in b && 'iv' in b && 'data' in b;
}

/** 校验信封是否是本应用的迁移包,返回业务负载类型(明文则透传,密文则加密信封)。 */
export function assertBundle(b: unknown): BundleEnvelope {
  if (!b || typeof b !== 'object') throw new Error('无效的迁移包文件');
  const e = b as Partial<BundleEnvelope>;
  if (e.app !== BUNDLE_APP) throw new Error('不是本应用的迁移包文件');
  if (e.version !== BUNDLE_VERSION) throw new Error(`不支持的迁移包版本:${e.version}`);
  return e as BundleEnvelope;
}
