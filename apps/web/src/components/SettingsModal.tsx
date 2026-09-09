import { useEffect, useRef, useState } from 'react';
import { authApi, isPhoneMode } from '../api';
import { uploadImage } from '../lib/image';
import type { BundleEnvelope } from '@diary/shared/bundle';
import { exportCurrentToBundle, importBundleFile } from '../lib/backup';
import ResolvedImage from './ResolvedImage';

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
  // —— 修改个人信息 ——
  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [profMsg, setProfMsg] = useState('');
  const [profMsgOk, setProfMsgOk] = useState(false);
  const [profBusy, setProfBusy] = useState(false);
  const avatarRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    authApi
      .me()
      .then((r) => {
        setUsername(r.username);
        setNickname(r.nickname ?? '');
        setAvatar(r.avatar);
        setEmail(r.email);
      })
      .catch(() => {});
  }, []);

  async function pickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const ref = await uploadImage(file);
      setAvatar(ref);
      setProfMsgOk(true);
      setProfMsg('头像已选择,点「保存修改」生效。');
    } catch (err) {
      setProfMsgOk(false);
      setProfMsg((err as Error).message || '头像上传失败');
    }
  }

  async function saveProfile() {
    if (profBusy) return;
    setProfBusy(true);
    setProfMsg('');
    try {
      await authApi.updateProfile({ nickname, username, avatar });
      setProfMsgOk(true);
      setProfMsg('已保存 ✅');
    } catch (e) {
      setProfMsgOk(false);
      setProfMsg((e as Error).message || '保存失败');
    } finally {
      setProfBusy(false);
    }
  }

  // —— 绑定 / 解绑邮箱 ——
  const [bindEmail, setBindEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState('');
  const [emailOk, setEmailOk] = useState(false);
  async function bindEmailNow() {
    if (emailBusy) return;
    setEmailMsg('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bindEmail.trim())) {
      setEmailOk(false);
      setEmailMsg('邮箱格式不正确');
      return;
    }
    setEmailBusy(true);
    try {
      await authApi.bindEmail(bindEmail.trim());
      setEmail(bindEmail.trim());
      setEmailOk(true);
      setEmailMsg('邮箱已绑定 ✅');
      setBindEmail('');
    } catch (e) {
      setEmailOk(false);
      setEmailMsg((e as Error).message || '绑定失败');
    } finally {
      setEmailBusy(false);
    }
  }
  async function unbindEmailNow() {
    if (emailBusy) return;
    setEmailBusy(true);
    setEmailMsg('');
    try {
      await authApi.unbindEmail();
      setEmail(null);
      setEmailOk(true);
      setEmailMsg('已解绑邮箱。');
    } catch (e) {
      setEmailOk(false);
      setEmailMsg((e as Error).message || '解绑失败');
    } finally {
      setEmailBusy(false);
    }
  }

  // —— 修改密码 ——
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState('');
  const [pwOk, setPwOk] = useState(false);
  async function changePw() {
    if (pwBusy) return;
    setPwMsg('');
    if (newPw.length < 6) {
      setPwOk(false);
      setPwMsg('新密码至少 6 位');
      return;
    }
    if (newPw !== confirmPw) {
      setPwOk(false);
      setPwMsg('两次输入的新密码不一致');
      return;
    }
    setPwBusy(true);
    try {
      await authApi.changePassword(oldPw, newPw);
      setPwOk(true);
      setPwMsg('密码已修改 ✅');
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (e) {
      setPwOk(false);
      setPwMsg((e as Error).message || '修改失败');
    } finally {
      setPwBusy(false);
    }
  }

  // —— 数据备份 / 迁移 ——
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(false);
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
        <button className="modal-close" onClick={onClose} title="关闭">×</button>
        <h2 className="modal-title">账户设置</h2>

        <h3 className="settings-section">修改个人信息</h3>
        <div className="avatar-row">
          {avatar ? (
            <ResolvedImage src={avatar} alt="头像" />
          ) : (
            <div className="avatar-preview empty">{(nickname || username || '?').slice(0, 1).toUpperCase()}</div>
          )}
          <button className="ghost" onClick={() => avatarRef.current?.click()}>更换头像</button>
          <input ref={avatarRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={pickAvatar} />
        </div>
        <input className="settings-input" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="昵称" />
        <input className="settings-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="账号(登录用)" style={{ marginTop: 8 }} />
        <p className="modal-hint">账号每半年可修改一次;唯一 ID 由系统分配,不随账号变。</p>
        <div className="modal-actions">
          <button className="primary" onClick={saveProfile} disabled={profBusy}>{profBusy ? '保存中…' : '保存修改'}</button>
        </div>
        {profMsg && <p className={profMsgOk ? 'backup-msg ok' : 'backup-msg'}>{profMsg}</p>}

        <h3 className="settings-section">绑定邮箱(找回密码)</h3>
        {email ? (
          <>
            <p className="modal-hint">当前绑定:<code>{email}</code></p>
            <div className="modal-actions">
              <button className="ghost" onClick={unbindEmailNow} disabled={emailBusy}>{emailBusy ? '处理中…' : '解绑邮箱'}</button>
            </div>
          </>
        ) : (
          <>
            <input className="settings-input" value={bindEmail} onChange={(e) => setBindEmail(e.target.value)} placeholder="you@example.com" type="email" />
            <div className="modal-actions">
              <button className="primary" onClick={bindEmailNow} disabled={emailBusy || !bindEmail.trim()}>{emailBusy ? '提交中…' : '绑定邮箱'}</button>
            </div>
          </>
        )}
        {emailMsg && <p className={emailOk ? 'backup-msg ok' : 'backup-msg'}>{emailMsg}</p>}

        <h3 className="settings-section">绑定微信 / 手机号</h3>
        <p className="modal-hint">微信扫码登录、手机号登录即将开放(本期仅用户名+密码、扫码)。</p>

        <h3 className="settings-section">重置密码</h3>
        <input className="settings-input" value={oldPw} onChange={(e) => setOldPw(e.target.value)} placeholder="当前密码" type="password" />
        <input className="settings-input" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="新密码(至少 6 位)" type="password" style={{ marginTop: 8 }} />
        <input className="settings-input" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="再次输入新密码" type="password" style={{ marginTop: 8 }} />
        <div className="modal-actions">
          <button className="primary" onClick={changePw} disabled={pwBusy}>{pwBusy ? '提交中…' : '修改密码'}</button>
        </div>
        {pwMsg && <p className={pwOk ? 'backup-msg ok' : 'backup-msg'}>{pwMsg}</p>}

        <h3 className="settings-section">数据备份 / 迁移</h3>
        <input className="settings-input" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="迁移包口令(可留空 = 明文)" type="password" />
        <div className="modal-actions">
          <button className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>导入迁移包</button>
          <button className="primary" onClick={doExport} disabled={busy}>{busy ? '处理中…' : '导出迁移包'}</button>
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onImportFile} />
        {msg && <p className={msgOk ? 'backup-msg ok' : 'backup-msg'}>{msg}</p>}
        {isPhoneMode() && <p className="modal-hint">手机端数据保存在本机,迁移包即整机备份,不对外上传。</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
