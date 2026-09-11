import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 原生相机(CameraX)桥接。
 * Android 上调用我们自己的 NativeCamera 插件:预览/方向/比例都由原生控制,
 * 和微信一致(铺满、不歪、无黑边),不需要旋转/重编码那套 Web 兜底方案。
 */
interface NativeCameraPlugin {
  open(): Promise<{ path?: string; mime?: string }>;
  readFile(options: { path: string; mime?: string }): Promise<{ data?: string; mime?: string }>;
}

const NativeCamera = registerPlugin<NativeCameraPlugin>('NativeCamera');

/** 当前环境是否可用原生相机(仅 Android App)。 */
export function nativeCameraAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 打开原生相机拍照/录像。返回 File(用户取消时返回 null)。
 * 取字节优先走 convertFileSrc(同源 http://localhost/_capacitor_file_/…,不经过 JS bridge),
 * 失败再退回插件的 readFile(base64)。
 */
export async function takeWithNativeCamera(): Promise<File | null> {
  const r = await NativeCamera.open();
  const path = r?.path;
  if (!path) return null;
  const name = baseName(path);

  try {
    const res = await fetch(Capacitor.convertFileSrc(path));
    if (res.ok) {
      const blob = await res.blob();
      return new File([blob], name, { type: r?.mime || blob.type || 'application/octet-stream' });
    }
  } catch {
    /* 回退到 readFile */
  }

  const data = await NativeCamera.readFile({ path, mime: r?.mime });
  if (!data?.data) return null;
  const bytes = base64ToBytes(data.data);
  // 复制到独立的 ArrayBuffer,避免 SharedArrayBuffer 类型不匹配
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  return new File([ab], name, { type: data.mime || r?.mime || 'application/octet-stream' });
}
