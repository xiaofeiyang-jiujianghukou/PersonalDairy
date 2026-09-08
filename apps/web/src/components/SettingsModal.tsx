import { useRef, useState } from 'react';
import { getApiBase, setApiBase, isPhoneMode } from '../api';
import type { BundleEnvelope } from '@diary/shared/bundle';
import { exportCurrentToBundle, importBundleFile } from '../lib/backup';

function downloadEnvelope(envelope: BundleEnvelope) {
  const name = `diary-bundle-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState(getApiBase());
  const [saved, setSaved] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(false);

  function save() {
    setApiBase(value);
    setSaved(true);
    setTimeout(() => {
      onClose();
      window.location.reload();
    }, 500);
  }

  async function doExport() {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      const envelope = await exportCurrentToBundle(passphrase.trim());
      downloadEnvelope(envelope);
      setMsgOk(true);
      setMsg(`已导出迁移包${passphrase.trim() ? '(已加密)' : '(明文)'}。`);
    } catch (err) {
      setMsgOk(false);
      setMsg(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await importBundleFile(file, passphrase.trim());
      setMsgOk(true);
      setMsg(`导入完成:新增 ${r.entriesImported} 条日记、${r.imagesImported} 张图片。`);
    } catch (err) {
      setMsgOk(false);
      setMsg(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">设置</h2>

        <h3 className="settings-section">日记服务器</h3>
        <p className="modal-hint">
          留空 = 使用当前页面自带的日记服务。手机端 App 请填你电脑上日记服务的地址,例如{' '}
          <code>http://192.168.1.10:4520</code>(需手机与电脑同一网络)。
        </p>
        <input
          className="settings-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="http://电脑IP:4520(留空 = 同源)"
          autoFocus
        />
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>关闭</button>
          <button className="primary" onClick={save}>{saved ? '已保存…' : '保存'}</button>
        </div>

        <h3 className="settings-section">数据备份 / 迁移</h3>
        <p className="modal-hint">
          导出当前设备全部日记与图片为单个文件,可在另一台设备导入合并(LWW 按最后修改取新)。
          口令留空 = 明文文件;填写 = AES-256 加密,迁移时需同一口令。
        </p>
        <input
          className="settings-input"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="迁移包口令(可留空 = 明文)"
          type="password"
        />
        <div className="modal-actions">
          <button className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
            导入迁移包
          </button>
          <button className="primary" onClick={doExport} disabled={busy}>
            {busy ? '处理中…' : '导出迁移包'}
          </button>
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onImportFile} />
        {msg && <p className={msgOk ? 'backup-msg ok' : 'backup-msg'}>{msg}</p>}
        {isPhoneMode() && (
          <p className="modal-hint">手机端数据保存在本机,迁移包即整机备份,不对外上传。</p>
        )}
      </div>
    </div>
  );
}
