import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 应用内微信式相机(布局对齐微信):
 *   左上角 ×(关闭)
 *   底部一行提示:轻触拍照,长按摄像
 *   下方一行:⚡(左) ｜ 快门(中) ｜ ⟳ 切换前后置(右)
 *
 * 交互:
 *   - 轻触快门 → 拍照(canvas 取当前帧)
 *   - 长按快门 → 摄像(MediaRecorder,带声音),松开结束并回调视频
 * 拍到的 File 交给 onCapture,由调用方插入编辑器。
 *
 * 长按用**非 passive 的原生 touch 监听 + preventDefault**:否则浏览器会把"按住"
 * 认领成手势(长按/选择)而只发 touchcancel,收不到"松开"。
 */
export default function CameraCapture({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shutterRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingRef = useRef(false);
  const busyRef = useRef(false);

  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [canRecord, setCanRecord] = useState(true);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  // 适配:横屏流(1920x1080)在竖屏界面里要**旋转 90° 并 cover** 才能铺满(微信那样);
  // 竖屏流则直接 cover。拍照时按同样的方向把画面转正,避免存下来是歪的。
  const [rotate90, setRotate90] = useState(false);

  // ---------- 打开/切换摄像头 ----------
  const openStream = useCallback(async (mode: 'environment' | 'user') => {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const s = await navigator.mediaDevices.getUserMedia({
        // 优先要"竖屏"流(1080x1920),这样竖屏界面里能铺满且只轻微裁切
        video: { facingMode: mode, width: { ideal: 1080 }, height: { ideal: 1920 } },
        audio: true,
      });
      streamRef.current = s;
      const v = videoRef.current;
      if (v) {
        v.srcObject = s;
        await v.play().catch(() => undefined);
      }
      setReady(true);
      setErr(null);
    } catch (e) {
      setErr(`无法打开相机:${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void openStream(facing);
  }, [facing, openStream]);

  useEffect(() => {
    setCanRecord(typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined');
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const rec = recorderRef.current;
      if (rec && rec.state === 'recording') {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  // ---------- 闪光灯 ----------
  // 不预先禁用:有些机型 getCapabilities() 不上报 torch,但 applyConstraints 实际可用。
  // 所以一律可点,失败时才提示"不支持"。
  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
      setTorchSupported(true);
    } catch {
      setTorchSupported(false);
      setNotice('这台设备不支持应用内闪光灯,可用系统相机拍');
    }
  }, [torchOn]);

  // ---------- 拍照:取当前帧(按预览方向转正) ----------
  const shootPhoto = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return; // 画面还没就绪,忽略这次轻触
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const rot = rotate90;
    const c = document.createElement('canvas');
    c.width = rot ? vh : vw;
    c.height = rot ? vw : vh;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.save();
    if (rot) {
      // 预览顺时针转了 90°,照片同步顺时针转 90°,保证"所见即所得"且方向正确
      ctx.translate(c.width, 0);
      ctx.rotate(Math.PI / 2);
    }
    ctx.drawImage(v, 0, 0, vw, vh);
    ctx.restore();
    const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.92));
    if (!blob) return;
    onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }));
  }, [onCapture, rotate90]);

  // ---------- 摄像 ----------
  const startRecording = useCallback(() => {
    const s = streamRef.current;
    const v = videoRef.current;
    if (!s || !v || recordingRef.current) return;
    if (typeof window.MediaRecorder === 'undefined') return;
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(
      (m) => {
        try {
          return MediaRecorder.isTypeSupported(m);
        } catch {
          return false;
        }
      },
    );

    // 预览旋转过 90° 时,录像也要转正:用 canvas 合成(旋转画面 + 原声)
    let recStream: MediaStream = s;
    let canvas: HTMLCanvasElement | null = null;
    let raf = 0;
    if (rotate90 && typeof HTMLCanvasElement.prototype.captureStream === 'function') {
      canvas = document.createElement('canvas');
      canvas.width = v.videoHeight;
      canvas.height = v.videoWidth;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const draw = () => {
          if (!canvas) return;
          ctx.save();
          ctx.translate(canvas.width, 0);
          ctx.rotate(Math.PI / 2);
          ctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight);
          ctx.restore();
          raf = requestAnimationFrame(draw);
        };
        draw();
        const cstream = canvas.captureStream(30);
        for (const t of s.getAudioTracks()) cstream.addTrack(t);
        recStream = cstream;
      }
    }

    const chunks: Blob[] = [];
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    } catch {
      if (raf) cancelAnimationFrame(raf);
      setErr('这台设备不支持应用内录像,请用「从手机相册选择」。');
      setCanRecord(false);
      return;
    }
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      if (raf) cancelAnimationFrame(raf);
      recordingRef.current = false;
      setRecording(false);
      const blob = new Blob(chunks, { type: chunks[0]?.type || mime || 'video/webm' });
      if (!blob.size) return;
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      onCapture(new File([blob], `video-${Date.now()}.${ext}`, { type: blob.type || 'video/webm' }));
    };
    recorderRef.current = rec;
    rec.start();
    recordingRef.current = true;
    setRecording(true);
    setSecs(0);
  }, [onCapture, rotate90]);

  const stopRecording = useCallback(() => {
    if (!recordingRef.current) return;
    try {
      recorderRef.current?.stop();
    } catch {
      recordingRef.current = false;
      setRecording(false);
    }
  }, []);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  // ---------- 快门:轻触拍照 / 长按摄像(原生非 passive 触摸) ----------
  useEffect(() => {
    const el = shutterRef.current;
    if (!el) return;
    const LONG_MS = 350;
    const onStart = (e: Event) => {
      if (e.cancelable) e.preventDefault();
      if (busyRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (canRecord) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          startRecording();
        }, LONG_MS);
      }
    };
    const onEnd = (e: Event) => {
      if (e.cancelable) e.preventDefault();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (recordingRef.current) {
        stopRecording();
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      void shootPhoto().finally(() => {
        busyRef.current = false;
      });
    };
    const onCancel = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (recordingRef.current) stopRecording();
    };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', onCancel, { passive: false });
    el.addEventListener('mousedown', onStart);
    el.addEventListener('mouseup', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
      el.removeEventListener('mousedown', onStart);
      el.removeEventListener('mouseup', onEnd);
    };
  }, [canRecord, shootPhoto, startRecording, stopRecording]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(t);
  }, [notice]);

  return (
    <div className="camera-overlay">
      <video
        ref={videoRef}
        className={`camera-video${rotate90 ? ' rot90' : ''}${facing === 'user' ? ' mirror' : ''}`}
        playsInline
        muted
        autoPlay
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          const landscapeStream = v.videoWidth > v.videoHeight;
          const portraitScreen = window.innerHeight > window.innerWidth;
          const rot = landscapeStream && portraitScreen;
          setRotate90(rot);
        }}
      />

      {!ready && !err && <p className="camera-hint">正在打开相机…</p>}
      {err && <p className="camera-err">{err}</p>}

      {/* 左上角:关闭(半透明,不遮挡画面) */}
      <button className="camera-close" onClick={onClose} aria-label="关闭">
        ✕
      </button>

      <div className="camera-bottom">
        <p className="camera-tip">
          {recording ? `● 摄像中 ${secs}s · 松手结束` : '轻触拍照,长按摄像'}
        </p>
        <div className="camera-controls">
          <button
            className={`camera-side-btn${torchOn ? ' on' : ''}${torchSupported ? '' : ' off'}`}
            onClick={() => void toggleTorch()}
            aria-label="闪光灯"
            title="闪光灯"
          >
            ⚡
          </button>

          <div
            ref={shutterRef}
            className={`camera-shutter${recording ? ' recording' : ''}`}
            role="button"
            aria-label="快门"
          >
            <span className="camera-shutter-inner" />
          </div>

          <button
            className="camera-side-btn"
            onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
            aria-label="切换摄像头"
            title="切换前后置摄像头"
          >
            ⟳
          </button>
        </div>
        {!canRecord && <p className="camera-tip warn">这台设备不支持应用内录像</p>}
        {notice && <p className="camera-tip warn">{notice}</p>}
      </div>
    </div>
  );
}
