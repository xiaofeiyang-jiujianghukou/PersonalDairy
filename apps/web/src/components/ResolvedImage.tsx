import { useEffect, useState } from 'react';
import { resolveMediaRef } from '../lib/image';
import { isTauri } from '../lib/net';

/**
 * 桌面端(Linux/WebKitGTK)在部分显卡上渲染 H.264 会花屏 —— 文件本身没问题
 * (ffmpeg 校验零报错、抽帧画面正确)。所以桌面端不内嵌播放,改为把视频交给系统播放器。
 */
async function openExternally(url: string): Promise<void> {
  const blob = await (await fetch(url)).blob();
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  const ext = (blob.type.split('/')[1] || 'mp4').split(';')[0];
  // 直接用 Tauri v2 的内置桥接,避免再引一个依赖(本仓库依赖树是 pnpm 严格链接)
  const inv = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } })
    .__TAURI_INTERNALS__?.invoke;
  if (!inv) throw new Error('当前环境不支持调用系统播放器');
  await inv('open_media_file', { name: `diary-video-${Date.now()}.${ext}`, data: bytes });
}

/** 把媒体引用(diary-video:/diary-img:/uploads/url/data URL)异步解析为可显示 URL。
 *  视频引用渲染为 <video>,图片渲染为 <img>。 */
export default function ResolvedImage({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isVideo = !!src && src.startsWith('diary-video:');
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState(false);
  // 桌面端用系统播放器打开视频(绕开 WebKit 的花屏问题)
  const useExternalPlayer = isVideo && isTauri();

  useEffect(() => {
    let alive = true;
    let objectUrl = '';
    setUrl(null);
    setFailed(false);
    if (!src) {
      setFailed(true);
      return;
    }
    resolveMediaRef(src)
      .then((u) => {
        if (!alive) return;
        if (u) {
          objectUrl = u;
          setUrl(u);
        } else {
          setFailed(true);
        }
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed) return <span className="img-broken">{isVideo ? '视频' : '图片'}</span>;
  if (!url) return <span className="img-loading">{isVideo ? '视频…' : '图片…'}</span>;
  if (isVideo && useExternalPlayer) {
    return (
      <button
        type="button"
        className="video-external"
        disabled={opening}
        onClick={async () => {
          setOpening(true);
          try {
            await openExternally(url);
            setOpened(true);
          } catch (e) {
            alert(`打开视频失败:${(e as Error).message}`);
          } finally {
            setOpening(false);
          }
        }}
      >
        <span className="video-external-icon">▶</span>
        <span>{opening ? '正在打开…' : opened ? '已用系统播放器打开(可再点一次)' : '用系统播放器打开视频'}</span>
      </button>
    );
  }
  return isVideo ? (
    <video className="img video" src={url} controls playsInline />
  ) : (
    <img className="img" src={url} alt={alt || ''} />
  );
}
