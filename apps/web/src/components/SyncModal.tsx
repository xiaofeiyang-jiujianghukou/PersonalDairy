import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { isPhoneMode, getSyncPartner, setSyncPartner, setSyncKey, syncNow } from '../api';

export default function SyncModal({ onClose }: { onClose: () => void }) {
  const phoneMode = isPhoneMode();
  const [partner, setPartner] = useState(getSyncPartner());
  const [qr, setQr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);

  // 桌面(电脑)端:展示二维码,供手机扫
  useEffect(() => {
    if (!phoneMode) {
      fetch('/api/qr')
        .then((r) => r.json())
        .then((d) => setQr(d.dataUrl))
        .catch(() => setErr('读取二维码失败,请直接在电脑上打开 http://localhost:4520'));
    }
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  async function startScan() {
    setErr(null);
    setMsg(null);
    // 先进入扫描态(让 <video> 先挂载),再请求相机
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        setScanning(false);
        setErr('视频画布尚未就绪,请重试');
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      const loop = () => {
        const v = videoRef.current;
        if (v && v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth) {
          const canvas = document.createElement('canvas');
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(v, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code && code.data) {
            const [u, k] = code.data.split('\n');
            if (u) {
              setSyncPartner(u);
              setPartner(u);
            }
            if (k) setSyncKey(k);
            stopCamera();
            setMsg(`已配对:${u ?? code.data}`);
            return;
          }
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setScanning(false);
      setErr((e as Error).message || '无法启动相机');
    }
  }

  async function doSync() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const r = await syncNow();
      setMsg(`同步完成:推送 ${r.applied} 条改动,拉取 ${r.pulled} 条。`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">配对与同步</h2>

        {phoneMode ? (
          <>
            <p className="modal-hint">
              数据存在你手机本地。扫描电脑上日记服务的二维码即可配对并同步(需同一 Wi-Fi)。
            </p>
            {partner ? (
              <p className="modal-hint">
                当前配对:<code>{partner}</code>
              </p>
            ) : (
              <p className="modal-hint warn">尚未配对电脑。</p>
            )}
            <video
              ref={videoRef}
              className="qr-video"
              playsInline
              muted
              style={{ display: scanning ? 'block' : 'none' }}
            />
            <div className="modal-actions">
              <button className="ghost" onClick={stopCamera} disabled={!scanning}>
                停止
              </button>
              <button className="primary" onClick={startScan} disabled={scanning}>
                {scanning ? '扫描中…' : '扫描电脑二维码'}
              </button>
              <button className="primary" onClick={doSync} disabled={busy || !partner}>
                {busy ? '同步中…' : '立即同步'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-hint">
              用手机 App 扫下方二维码即可和这台电脑配对同步(需同一 Wi-Fi)。
            </p>
            {qr ? (
              <img className="qr-img" src={qr} alt="配对二维码" />
            ) : (
              <p className="muted">正在生成二维码…</p>
            )}
          </>
        )}

        {msg && <p className="ok">{msg}</p>}
        {err && <p className="err">{err}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
