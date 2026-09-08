import { useEffect, useState } from 'react';
import { authApi, setToken } from '../api';

export default function AuthGate({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'qr'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ qrId: string; dataUrl: string } | null>(null);

  async function submit() {
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const fn = mode === 'login' ? authApi.login : authApi.register;
      const r = await fn(username.trim(), password);
      setToken(r.token);
      onAuthed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startQr() {
    setError(null);
    try {
      setQr(await authApi.loginQr());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!qr) return;
    const timer = setInterval(async () => {
      try {
        const p = await authApi.loginQrPoll(qr.qrId);
        if (p.status === 'confirmed' && p.token) {
          setToken(p.token);
          clearInterval(timer);
          onAuthed();
        }
      } catch {
        /* 继续轮询 */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [qr, onAuthed]);

  if (mode === 'qr') {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <h1 className="auth-title">扫码登录</h1>
          <p className="auth-sub">用手机「我的日记」扫一扫二维码,即可登录</p>
          {qr ? (
            <img className="qr-img" src={qr.dataUrl} alt="登录码" />
          ) : (
            <p className="muted">正在生成登录码…</p>
          )}
          {error && <p className="err">{error}</p>}
          <div className="auth-actions">
            <button className="ghost" onClick={() => setMode('login')}>返回</button>
            {!qr && <button className="primary" onClick={startQr}>生成登录码</button>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <h1 className="auth-title">我的日记</h1>
        <p className="auth-sub">{mode === 'login' ? '登录以继续' : '创建一个账号'}</p>
        <input
          className="settings-input"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          className="settings-input"
          type="password"
          placeholder="密码(至少 6 位)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <p className="err">{error}</p>}
        <div className="auth-actions">
          <button className="primary" onClick={submit} disabled={busy || !username.trim() || !password}>
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </button>
          <button className="ghost" onClick={() => { setMode('qr'); }}>
            扫码登录
          </button>
          <button className="ghost" onClick={() => { setMode((m) => (m === 'login' ? 'register' : 'login')); setError(null); }}>
            {mode === 'login' ? '没有账号?注册' : '已有账号?登录'}
          </button>
        </div>
        <p className="auth-hint">手机号登录、微信登录即将开放(本期仅用户名+密码、扫码)。</p>
      </div>
    </div>
  );
}
