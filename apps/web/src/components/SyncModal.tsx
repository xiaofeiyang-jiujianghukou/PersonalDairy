import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { nativeCameraAvailable, scanWithNativeCamera } from '../lib/nativeCamera';
import QRCode from 'qrcode';
import { encryptObject, generateSyncKey } from '@diary/shared/syncCrypto';
import { autoSync } from '../lib/syncAuto';
import {
  authApi,
  isPhoneMode,
  isPhoneApp,
  getSyncPartner,
  setSyncPartner,
  getSyncKey,
  setSyncKey,
  setLastSyncAt,
  setRelayCursor,
  syncNow,
  relaySyncNow,
} from '../api';

export default function SyncModal({ onClose }: { onClose: () => void }) {
  const phoneMode = isPhoneMode();
  const isPhone = isPhoneApp(); // 手机 App(极简:只扫码);桌面壳保留完整同步管理
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

  /** 处理扫到的内容(diary-sync: / diary-login: / 旧的 uid+key 格式)。 */
  function handleScanData(data: string) {
    if (data.startsWith('diary-sync:')) {
      const key = data.slice('diary-sync:'.length);
      setSyncKey(key);
      setPartner('');
      stopCamera();
      setMsg('已配对:同步密钥已建立,正在自动同步…');
      void autoSync().then((r) => {
        setMsg(r.ok ? `同步完成:拉取并合并 ${r.pulled ?? 0} 条。` : '同步失败,请检查网络或同步密钥。');
      });
      return;
    }
    if (data.startsWith('diary-login:')) {
      const qrId = data.slice('diary-login:'.length);
      stopCamera();
      setMsg('正在确认电脑登录…');
      void (async () => {
        try {
          // 顺带把本机同步密钥用一次性 qrId 加密交给电脑端 → 电脑登录后即可立即同步
          const myKey = getSyncKey();
          const encSyncKey = myKey ? JSON.stringify(await encryptObject(qrId, myKey)) : undefined;
          await authApi.scanConfirm(qrId, encSyncKey);
          setMsg(encSyncKey ? '已确认:电脑已登录并接入同步 ✅' : '已确认:电脑登录成功 ✅');
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
  }

  async function startScan() {
    setErr(null);
    setMsg(null);
    setHostQr(null);

    // 手机 App:直接用我们自己的原生相机扫码(相机界面统一,识别更稳)
    if (nativeCameraAvailable()) {
      setScanning(true);
      try {
        const text = await scanWithNativeCamera();
        if (text) handleScanData(text);
        else setMsg('没有识别到二维码,可以再试一次。');
      } catch {
        // 用户取消(✕)不算错误
        setMsg(null);
      } finally {
        setScanning(false);
      }
      return;
    }

    // 浏览器 / 桌面端兜底:原来的网页相机
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
            handleScanData(code.data);
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

  // 强制全量:重置"推送水位"和"拉取游标",让本机把全部日记重推给中继、并从头全量拉取
  // (修复:只清水位会导致清了推、却仍从旧游标往后拉 → 永远错过前面漏掉的消息)
  async function doFullRelaySync() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      setLastSyncAt(''); // 清空水位 → 推送全部
      setRelayCursor(0); // 归零游标 → 从头全量拉取(补回之前漏掉的对端消息)
      const r = await relaySyncNow();
      setMsg(`同步完成:推送 ${r.pushed} 条,拉取合并 ${r.pulled} 条。`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{isPhone ? '扫一扫' : '同步'}</h2>

        {isPhone ? (
          <>
            <p className="modal-hint">
              对着**电脑端「扫码登录」页**上的二维码扫一下,即可登录电脑端。
              之后同步全自动:任一设备更新,其他设备秒级同步。数据端到端加密,只在你的设备间传递。
            </p>
            <video
              ref={videoRef}
              className="qr-video"
              playsInline
              muted
              style={{ display: scanning ? 'block' : 'none' }}
            />
            <div className="modal-actions">
              <button className="primary" onClick={startScan} disabled={scanning}>
                {scanning ? '扫描中…' : '开始扫一扫'}
              </button>
              {scanning && <button className="ghost" onClick={stopCamera}>停止</button>}
            </div>
            {msg && <p className="ok">{msg}</p>}
            {err && <p className="err">{err}</p>}
          </>
        ) : (
          <>
            <p className="modal-hint">
              同步已**全自动**:打开或登录后,本机会自动与你的其它设备互相同步,无需手动操作。
            </p>
            {getSyncKey() ? (
              <p className="modal-hint">已就绪 ✓ 与你的其它设备共用同一同步密钥。</p>
            ) : (
              <p className="modal-hint warn">尚未就绪:请退出后用账号密码重新登录一次。</p>
            )}
            <div className="modal-actions">
              <button
                className="ghost"
                onClick={doFullRelaySync}
                disabled={busy}
                title="把本机全部日记重新推送,并从头全量拉取(数据对不上时用)"
              >
                {busy ? '同步中…' : '强制全量同步'}
              </button>
            </div>
            {msg && <p className="ok">{msg}</p>}
            {err && <p className="err">{err}</p>}
          </>
        )}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
