import { useEffect, useState } from 'react';
import { authApi, setToken } from '../api';

export default function AuthGate({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'qr' | 'forgot'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [regStep, setRegStep] = useState<'send' | 'code'>('send');
  const [regCode, setRegCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [qr, setQr] = useState<{ qrId: string; dataUrl: string } | null>(null);

  // 忘记密码
  const [fStep, setFStep] = useState<'send' | 'reset'>('send');
  const [fCode, setFCode] = useState('');
  const [fNewPw, setFNewPw] = useState('');
  const [fConfirm, setFConfirm] = useState('');

  async function submit() {
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      if (mode === 'login') {
        const r = await authApi.login(username.trim(), password);
        setToken(r.token);
        onAuthed();
      } else {
        // 注册:先发邮箱验证码
        if (!email.trim()) {
          setError('请填写邮箱');
          return;
        }
        await authApi.register(username.trim(), email.trim(), password);
        setRegStep('code');
        setOk('验证码已发送到邮箱,请输入验证码完成注册。');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmReg() {
    if (!regCode.trim()) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await authApi.registerConfirm(username.trim(), regCode.trim());
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

  async function sendForgot() {
    if (!username.trim()) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await authApi.forgot(username.trim());
      setFStep('reset');
      setOk('验证码已发送到你的绑定邮箱(若没收到,见服务器日志/检查绑定邮箱)。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doReset() {
    if (!username.trim() || !fCode.trim() || !fNewPw) return;
    setError(null);
    setOk(null);
    if (fNewPw.length < 6) {
      setError('新密码至少 6 位');
      return;
    }
    if (fNewPw !== fConfirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      await authApi.reset(username.trim(), fCode.trim(), fNewPw);
      setOk('密码已重置 ✅,用新密码登录。');
      setTimeout(() => {
        setMode('login');
        setPassword('');
        setFStep('send');
        setFCode('');
        setFNewPw('');
        setFConfirm('');
        setOk(null);
      }, 1200);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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

  if (mode === 'forgot') {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <h1 className="auth-title">忘记密码</h1>
          <p className="auth-sub">{fStep === 'send' ? '输入用户名,验证码会发到绑定邮箱' : '输入验证码并设置新密码'}</p>

          {fStep === 'send' ? (
            <>
              <input
                className="settings-input"
                placeholder="用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
              {ok && <p className="ok">{ok}</p>}
              {error && <p className="err">{error}</p>}
              <div className="auth-actions">
                <button className="ghost" onClick={() => setMode('login')}>返回</button>
                <button className="primary" onClick={sendForgot} disabled={busy || !username.trim()}>
                  {busy ? '发送中…' : '发送验证码'}
                </button>
              </div>
            </>
          ) : (
            <>
              <input
                className="settings-input"
                placeholder="6 位验证码"
                value={fCode}
                onChange={(e) => setFCode(e.target.value)}
                autoFocus
              />
              <input
                className="settings-input"
                type="password"
                placeholder="新密码(至少 6 位)"
                value={fNewPw}
                onChange={(e) => setFNewPw(e.target.value)}
                style={{ marginTop: 8 }}
              />
              <input
                className="settings-input"
                type="password"
                placeholder="再次输入新密码"
                value={fConfirm}
                onChange={(e) => setFConfirm(e.target.value)}
                style={{ marginTop: 8 }}
              />
              {ok && <p className="ok">{ok}</p>}
              {error && <p className="err">{error}</p>}
              <div className="auth-actions">
                <button className="ghost" onClick={() => { setFStep('send'); setError(null); }}>
                  重新发送
                </button>
                <button className="primary" onClick={doReset} disabled={busy || !fCode.trim() || !fNewPw}>
                  {busy ? '重置中…' : '重置密码'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <h1 className="auth-title">PersonalDiary</h1>
        <p className="auth-sub">{mode === 'login' ? '登录以继续' : '创建一个账号'}</p>
        {mode === 'register' && regStep === 'code' ? (
          <>
            <input className="settings-input" placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} disabled />
            <input
              className="settings-input"
              placeholder="6 位邮箱验证码"
              value={regCode}
              onChange={(e) => setRegCode(e.target.value)}
              autoFocus
              style={{ marginTop: 8 }}
            />
            {ok && <p className="ok">{ok}</p>}
            {error && <p className="err">{error}</p>}
            <div className="auth-actions">
              <button className="ghost" onClick={() => { setRegStep('send'); setRegCode(''); setError(null); }}>
                重新发送
              </button>
              <button className="primary" onClick={confirmReg} disabled={busy || !regCode.trim()}>
                {busy ? '注册中…' : '确认并注册'}
              </button>
            </div>
          </>
        ) : (
          <>
            <input
              className="settings-input"
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
            {mode === 'register' && (
              <input
                className="settings-input"
                type="email"
                placeholder="邮箱(必填,用于找回密码)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ marginTop: 8 }}
              />
            )}
            <input
              className="settings-input"
              type="password"
              placeholder="密码(至少 6 位)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              style={mode === 'register' ? { marginTop: 8 } : undefined}
            />
            {ok && <p className="ok">{ok}</p>}
            {error && <p className="err">{error}</p>}
            <div className="auth-actions">
              <button
                className="primary"
                onClick={submit}
                disabled={busy || !username.trim() || !password || (mode === 'register' && !email.trim())}
              >
                {busy ? '请稍候…' : mode === 'login' ? '登录' : '发送验证码'}
              </button>
              <button className="ghost" onClick={() => { setMode('qr'); setError(null); }}>
                扫码登录
              </button>
              <button className="ghost" onClick={() => { setMode((m) => (m === 'login' ? 'register' : 'login')); setRegStep('send'); setRegCode(''); setError(null); }}>
                {mode === 'login' ? '没有账号?注册' : '已有账号?登录'}
              </button>
              <button className="ghost" onClick={() => { setMode('forgot'); setError(null); setOk(null); }}>
                忘记密码?
              </button>
            </div>
          </>
        )}
        <p className="auth-hint">手机号登录、微信登录即将开放(本期仅用户名+密码、扫码)。</p>
      </div>
    </div>
  );
}
