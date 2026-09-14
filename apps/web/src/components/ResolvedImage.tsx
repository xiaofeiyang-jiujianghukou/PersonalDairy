import { useEffect, useState } from 'react';
import { resolveMediaRef } from '../lib/image';
import { isTauri } from '../lib/net';

/**
 * 桌面端(Linux/WebKitGTK)在部分显卡上渲染 H.264 会花屏 —— 文件本身没问题
 * (ffmpeg 校验零报错、抽帧画面正确)。所以桌面端不内嵌播放,改为把视频交给系统播放器。
 */
/**
 * 取视频第一帧做封面图。
 *
 * 关键发现:WebKit 只是**渲染到屏幕**时花屏,解码本身是好的 ——
 * 所以把 video 画到 canvas 上能拿到正确的画面,用它当封面即可,不必再显示难看的空方框。
 */
function firstFrame(url: string): Promise<{ poster: string; seconds: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    const done = (r: { poster: string; seconds: number } | null): void => {
      v.removeAttribute('src');
      resolve(r);
    };
    const timer = window.setTimeout(() => done(null), 6000);
    v.onloadeddata = () => {
      try {
        v.currentTime = Math.min(0.1, (v.duration || 1) / 10);
      } catch {
        /* 忽略 */
      }
    };
    v.onseeked = () => {
      window.clearTimeout(timer);
      try {
        const w = 640;
        const h = Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * w) || 360;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')?.drawImage(v, 0, 0, w, h);
        done({ poster: c.toDataURL('image/jpeg', 0.72), seconds: Math.round(v.duration || 0) });
      } catch {
        done(null);
      }
    };
    v.onerror = () => {
      window.clearTimeout(timer);
      done(null);
    };
  });
}

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
  const [poster, setPoster] = useState<{ poster: string; seconds: number } | null>(null);
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

  // 桌面端:抽第一帧做封面(抽不到就退化成深色卡片)
  useEffect(() => {
    if (!useExternalPlayer || !url) return;
    let alive = true;
    void firstFrame(url).then((r) => alive && r && setPoster(r));
    return () => {
      alive = false;
    };
  }, [useExternalPlayer, url]);

  if (failed) return <span className="img-broken">{isVideo ? '视频' : '图片'}</span>;
  if (!url) return <span className="img-loading">{isVideo ? '视频…' : '图片…'}</span>;
  if (isVideo && useExternalPlayer) {
    return (
      <button
        type="button"
        className={`video-external${poster ? ' has-poster' : ''}`}
        style={poster ? { backgroundImage: `url(${poster.poster})` } : undefined}
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
        <span className="video-external-play" aria-hidden>
          <svg viewBox="0 0 24 24" width="26" height="26">
            <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
          </svg>
        </span>
        <span className="video-external-meta">
          <span className="video-external-title">{opening ? '正在打开…' : '点击用系统播放器播放'}</span>
          <span className="video-external-sub">
            {poster?.seconds ? `${String(Math.floor(poster.seconds / 60)).padStart(2, '0')}:${String(poster.seconds % 60).padStart(2, '0')} · ` : ''}
            {opened ? '已打开过,可再点' : '电脑端用系统播放器播放'}
          </span>
        </span>
      </button>
    );
  }
  return isVideo ? (
    <video className="img video" src={url} controls playsInline />
  ) : (
    <img className="img" src={url} alt={alt || ''} />
  );
}
