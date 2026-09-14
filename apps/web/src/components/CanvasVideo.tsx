import { useEffect, useRef, useState } from 'react';

/**
 * 桌面端(Linux/WebKitGTK)专用播放器:把解码后的画面**画到 canvas 上**播放。
 *
 * 为什么要这么绕:WebKitGTK 在这台 AMD 机器上,<video> 直接显示会花屏(绿条纹),
 * 但**解码本身是完好的** —— 证据:用 canvas 抽第一帧得到的画面完全正确。
 * 也就是说坏的只是"视频层合成到屏幕"这一步,那就自己把帧画出来,绕开它。
 * 声音仍由隐藏的 <video> 输出(音频走的是另一条管线,不受影响)。
 */
export default function CanvasVideo({ blobUrl }: { blobUrl: string }) {
  const [src, setSrc] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  /**
   * 诊断信息:视频失败的**真实原因**。
   * 之前我靠猜着改(改隐藏方式、改 play 重试)反复没解决 —— 现在把浏览器给的
   * 错误码 / readyState / networkState 直接显示出来,一眼定位,不再猜。
   */
  const [diag, setDiag] = useState('');
  const [full, setFull] = useState(false); // 铺满屏幕(同一个 canvas 放大,不重载)

  /*
   * 关键修复:把 blob: URL 转成 data: URL。
   * Tauri 的页面源是 tauri://localhost,媒体加载器无法加载该源下的 blob: ——
   * 实测症状:错误码 4(SRC_NOT_SUPPORTED) + networkState=3(NO_SOURCE),即"没有可用来源"。
   * 图片用 blob 正常,只有 <video> 是这样。
   */
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setDiag('');
    // 换视频时必须重置画布尺寸:否则会沿用上一条视频的宽高,导致方向/比例错乱(实测)
    const c0 = canvasRef.current;
    if (c0) {
      c0.width = 0;
      c0.height = 0;
    }
    void (async () => {
      try {
        const blob = await (await fetch(blobUrl)).blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error('读取视频数据失败'));
          fr.readAsDataURL(blob);
        });
        if (!alive) return;
        setSrc(dataUrl);
        setDiag(`data URL ${(dataUrl.length / 1024 / 1024).toFixed(1)}MB`);
      } catch (e) {
        if (alive) {
          setDiag(`转换失败:${(e as Error).message}`);
          setFailed(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [blobUrl]);

  // 打开后先静默预载一帧,让 canvas 立刻有画面(不自动出声)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onLoaded = (): void => {
      try {
        v.currentTime = 0.05;
      } catch {
        /* 忽略 */
      }
    };
    v.addEventListener('loadedmetadata', onLoaded);
    return () => v.removeEventListener('loadedmetadata', onLoaded);
  }, []);

  // 逐帧把视频画到 canvas
  useEffect(() => {
    let raf = 0;
    let stopped = false;
    let lastProgressAt = 0;
    const draw = (): void => {
      if (stopped) return;
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c) {
        const w = v.videoWidth || 720;
        const h = v.videoHeight || 1280;
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        const ctx = c.getContext('2d');
        if (ctx && v.readyState >= 2) {
          try {
            ctx.drawImage(v, 0, 0, w, h);
          } catch {
            /* 偶尔取不到帧就跳过这一帧 */
          }
        }
        /*
         * 注意:**绝不能在每帧里 setState** —— 一秒 60 次 React 重渲染会把界面拖垮
         * (实测症状:重新打开视频后画面卡住、像静止帧)。进度改为每 ~200ms 更新一次,
         * 播放/暂停状态由 video 的事件驱动。
         */
        const now = performance.now();
        if (v.duration && now - lastProgressAt > 200) {
          lastProgressAt = now;
          setProgress(v.currentTime / v.duration);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  // Esc 退出全屏
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  function toggle(): void {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) {
      v.pause();
      return;
    }
    /*
     * play() 的 reject 不一定代表不能播:重载/被新的 load 打断都会抛 AbortError。
     * 这时**不能**显示"无法播放"(实测误报)。只在真的播不动时才标记失败,并先重试一次。
     */
    void v.play().catch(() => {
      setTimeout(() => {
        const vv = videoRef.current;
        if (!vv) return;
        vv.load();
        void vv.play().catch(() => setFailed(true));
      }, 120);
    });
  }

  return (
    <div className={`canvas-video${full ? ' full' : ''}`} onClick={toggle}>
      <canvas ref={canvasRef} className="canvas-video-canvas" />
      <video
        ref={videoRef}
        src={src || undefined}
        playsInline
        preload="auto"
        /*
         * 藏 video 的坑(实测两次):
         *   · display:none → WebKit 不解码,canvas 没帧可画;
         *   · 1px / opacity≈0 → 同样不解码。
         * 所以让它**以正常尺寸待在 canvas 正下方**:对 WebKit 来说是"正常可见、正常解码",
         * 而用户看到的是上面那层 canvas(画面正确)。真正被藏起来的只是"坏掉的视频层"。
         */
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          zIndex: 0,
        }}
        onError={(e) => {
          const el = e.currentTarget;
          const err = el.error;
          setDiag(
            `错误码 ${err?.code ?? '?'}${err?.message ? ` · ${err.message}` : ''} · readyState=${el.readyState} · networkState=${el.networkState} · src=${el.currentSrc.slice(0, 24)}…`,
          );
          setFailed(true);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
      />
      {failed && (
        <div className="canvas-video-error">
          <div>这个视频无法播放</div>
          {diag && <div className="canvas-video-diag">{diag}</div>}
          <div className="canvas-video-diag">请把这段文字截图给开发者</div>
        </div>
      )}
      {/* 铺满屏幕 / 回到原位 */}
      <button
        type="button"
        className="canvas-video-full-btn"
        title={full ? '退出全屏' : '铺满屏幕'}
        onClick={(e) => {
          e.stopPropagation();
          setFull((v) => !v);
        }}
      >
        {full ? '⤡' : '⛶'}
      </button>
      {!failed && (
        <span className="canvas-video-play" aria-hidden>
          {playing ? '❚❚' : '▶'}
        </span>
      )}
      <div className="canvas-video-bar">
        <div className="canvas-video-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  );
}
