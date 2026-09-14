import { useEffect, useState } from 'react';

/**
 * 桌面端视频卡片:用系统播放器打开。
 *
 * 为什么桌面端不内嵌播放:这台机器上 WebKitGTK 的视频渲染有缺陷(绿条纹 / 方向错乱 /
 * 有时干脆加载不了),而**同一个文件交给系统播放器必定正常**。所以这里做成一张
 * 带**真实封面帧**的大卡片:一眼能看出是哪段视频,点一下交给系统播放器。
 *
 * 封面帧怎么来的:视频**解码**是好的(WebKit 只是把它画到屏幕上时出问题),
 * 所以把 video 画到 canvas 再导出成图片完全可行 —— 之前实测证明过。
 */
function grabFirstFrame(url: string): Promise<{ poster: string; seconds: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    const finish = (r: { poster: string; seconds: number } | null): void => {
      v.removeAttribute('src');
      resolve(r);
    };
    const timer = window.setTimeout(() => finish(null), 8000);
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
        const w = 720;
        const h = Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * w) || 405;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')?.drawImage(v, 0, 0, w, h);
        finish({ poster: c.toDataURL('image/jpeg', 0.75), seconds: Math.round(v.duration || 0) });
      } catch {
        finish(null);
      }
    };
    v.onerror = () => {
      window.clearTimeout(timer);
      finish(null);
    };
  });
}

function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function VideoCard({ url }: { url: string }) {
  const [poster, setPoster] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [state, setState] = useState<'idle' | 'opening' | 'opened' | 'error'>('idle');
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    void grabFirstFrame(url).then((r) => {
      if (!alive || !r) return;
      setPoster(r.poster);
      setSeconds(r.seconds);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  async function open(): Promise<void> {
    if (state === 'opening') return;
    setState('opening');
    setErr('');
    try {
      const blob = await (await fetch(url)).blob();
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const ext = (blob.type.split('/')[1] || 'mp4').split(';')[0];
      const inv = (
        window as unknown as {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;
      if (!inv) throw new Error('当前环境不支持调用系统播放器');
      await inv('open_media_file', { name: `diary-video-${Date.now()}.${ext}`, data: bytes });
      setState('opened');
    } catch (e) {
      setErr((e as Error).message);
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className={`video-card${poster ? ' has-poster' : ''}`}
      style={poster ? { backgroundImage: `url(${poster})` } : undefined}
      onClick={() => void open()}
    >
      <span className="video-card-play" aria-hidden>
        <svg viewBox="0 0 24 24" width="30" height="30">
          <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
        </svg>
      </span>
      <span className="video-card-meta">
        <span className="video-card-title">
          {state === 'opening' ? '正在打开…' : state === 'opened' ? '已打开,可再点一次' : '用系统播放器播放'}
        </span>
        <span className="video-card-sub">
          {seconds ? `${clock(seconds)} · ` : ''}
          {state === 'error' ? err || '打开失败' : '电脑端用系统播放器播放'}
        </span>
      </span>
    </button>
  );
}
