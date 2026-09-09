import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { generateSyncKey } from '@diary/shared/syncCrypto';
import {
  authApi,
  isPhoneMode,
  getSyncPartner,
  setSyncPartner,
  getSyncKey,
  setSyncKey,
  setLastSyncAt,
  syncNow,
  relaySyncNow,
} from '../api';

export default function SyncModal({ onClose }: { onClose: () => void }) {
  const phoneMode = isPhoneMode();
  const [partner, setPartner] = useState(getSyncPartner());
  const [hostQr, setHostQr] = useState<string | null>(null); // 本机展示的配对码(本地优先)
  const [remoteQr, setRemoteQr] = useState<string | null>(null); // 服务器生成的配对码(远程桌面)
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);

  // 远程桌面(非本地优先):展示服务器二维码,供手机扫
  useEffect(() => {
    if (!phoneMode) {
      fetch('/api/qr')
        .then((r) => r.json())
        .then((d) => setRemoteQr(d.dataUrl))
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

  /** 本地优先:生成/复用同步密钥并展示配对码(diary-sync:<key>,走云端中继,无需局域网地址)。 */
  async function showPairQr() {
    setErr(null);
    setMsg(null);
    let key = getSyncKey();
    if (!key) {
      key = generateSyncKey();
      setSyncKey(key);
    }
    try {
      const dataUrl = await QRCode.toDataURL(`diary-sync:${key}`, { margin: 1, width: 360 });
      setHostQr(dataUrl);
      setMsg('已生成配对码。用另一台设备「扫描二维码」即可建立同步密钥。');
    } catch (e) {
      setErr((e as Error).message || '生成二维码失败');
    }
  }

  async function startScan() {
    setErr(null);
    setMsg(null);
    setHostQr(null);
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
            const data = code.data;
            if (data.startsWith('diary-sync:')) {
              const key = data.slice('diary-sync:'.length);
              setSyncKey(key);
              setPartner('');
              stopCamera();
              setMsg('已配对:同步密钥已建立(走云端加密中继)✅');
              return;
            }
            if (data.startsWith('diary-login:')) {
              const qrId = data.slice('diary-login:'.length);
              stopCamera();
              setMsg('正在确认电脑登录…');
              void (async () => {
                try {
                  await authApi.scanConfirm(qrId);
                  setMsg('已确认:电脑登录成功 ✅');
                } catch (e) {
                  setErr((e as Error).message);
                }
              })();
              return;
            }
            const [u, k] = data.split('\n');
            if (u) {
              setSyncPartner(u);
              setPartner(u);
            }
            if (k) setSyncKey(k);
            stopCamera();
            setMsg(`已配对:${u ?? data}`);
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
      if (getSyncPartner()) {
        const r = await syncNow();
        setMsg(`同步完成:推送 ${r.applied} 条改动,拉取 ${r.pulled} 条。`);
      } else {
        const r = await relaySyncNow();
        setMsg(`经中继同步完成:拉取并合并 ${r.pulled} 条。`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doRelaySync() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const r = await relaySyncNow();
      setMsg(`经中继同步完成:拉取并合并 ${r.pulled} 条。`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // 强制全量:重置本地同步水位,让本机把"全部"日记重新推给中继(恢复丢数据的设备)
  async function doFullRelaySync() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      setLastSyncAt(''); // 清空水位 → 下次同步推送全部
      const r = await relaySyncNow();
      setMsg(`强制全量同步完成:拉取并合并 ${r.pulled} 条。`);
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

        <p className="modal-hint">
          数据只存在各设备本地。用「显示配对码 / 扫描二维码」在两台设备间建立同一同步密钥;
          之后经云端**加密中继**同步(内容端到端加密,服务器看不到明文)。
        </p>

        <video
          ref={videoRef}
          className="qr-video"
          playsInline
          muted
          style={{ display: scanning ? 'block' : 'none' }}
        />

        <div className="modal-actions">
          <button className="ghost" onClick={showPairQr} disabled={scanning}>
            显示配对码
          </button>
          <button className="ghost" onClick={stopCamera} disabled={!scanning}>
            停止
          </button>
          <button className="primary" onClick={startScan} disabled={scanning}>
            {scanning ? '扫描中…' : '扫描二维码'}
          </button>
          <button className="primary" onClick={doSync} disabled={busy}>
            {busy ? '同步中…' : '立即同步'}
          </button>
          <button className="ghost" onClick={doRelaySync} disabled={busy}>
            {busy ? '同步中…' : '经中继同步'}
          </button>
          <button className="ghost" onClick={doFullRelaySync} disabled={busy} title="清空本机同步水位,把全部日记重新推送(找回丢失的设备数据)">
            {busy ? '同步中…' : '强制全量同步'}
          </button>
        </div>

        {hostQr && (
          <>
            <p className="modal-hint">另一台设备点「扫描二维码」扫这个码:</p>
            <img className="qr-img" src={hostQr} alt="配对二维码" />
          </>
        )}
        {remoteQr && !phoneMode && (
          <>
            <p className="modal-hint">用手机 App 扫下方二维码即可配对同步:</p>
            <img className="qr-img" src={remoteQr} alt="配对二维码" />
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
