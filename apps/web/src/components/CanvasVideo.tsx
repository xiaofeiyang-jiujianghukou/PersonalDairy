import { useEffect, useRef, useState } from 'react';

/**
 * 桌面端(Linux/WebKitGTK)专用播放器:把解码后的画面**画到 canvas 上**播放。
 *
 * 为什么要这么绕:WebKitGTK 在这台 AMD 机器上,<video> 直接显示会花屏(绿条纹),
 * 但**解码本身是完好的** —— 证据:用 canvas 抽第一帧得到的画面完全正确。
 * 也就是说坏的只是"视频层合成到屏幕"这一步,那就自己把帧画出来,绕开它。
 * 声音仍由隐藏的 <video> 输出(音频走的是另一条管线,不受影响)。
 */
export default function CanvasVideo({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);

  // 逐帧把视频画到 canvas
  useEffect(() => {
    let raf = 0;
    let stopped = false;
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
        if (v.duration) setProgress(v.currentTime / v.duration);
        setPlaying(!v.paused);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  function toggle(): void {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => setFailed(true));
    else v.pause();
  }

  return (
    <div className="canvas-video" onClick={toggle}>
      <canvas ref={canvasRef} className="canvas-video-canvas" />
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="auto"
        style={{ display: 'none' }}
        onError={() => setFailed(true)}
        onEnded={() => setPlaying(false)}
      />
      {failed && <div className="canvas-video-error">这个视频无法播放</div>}
      {!playing && !failed && <span className="canvas-video-play">▶</span>}
      <div className="canvas-video-bar">
        <div className="canvas-video-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  );
}
