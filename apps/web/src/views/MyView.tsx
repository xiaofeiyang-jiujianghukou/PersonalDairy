import { useEffect, useState } from 'react';
import { authApi, clearToken, exportUrl, relaySyncNow, setLastSyncAt, setRelayCursor } from '../api';
import { getSyncEngine } from '../api';
import { getSyncChannel } from '../lib/syncAuto';
import SettingsModal from '../components/SettingsModal';
import CompanionModal from '../components/CompanionModal';
import ResolvedImage from '../components/ResolvedImage';

export default function MyView({ onOpenDay }: { onOpenDay: (date: string) => void }) {
  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCompanion, setShowCompanion] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // 本机同步自查状态(全部读本地,不发网络请求):通道 / 本机条目数 / 水位 / 上次同步
  const [channel, setChannel] = useState<'ws' | 'poll'>(getSyncChannel());
  const [localCount, setLocalCount] = useState<number | null>(null);
  const [localWatermark, setLocalWatermark] = useState('');
  const [diag, setDiag] = useState<{ lastSyncAt: string; lastError: string; lastErrorAt: string; lastHandled: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      setChannel(getSyncChannel());
      try {
        const eng = getSyncEngine();
        const [n, wm] = await Promise.all([eng.count(), eng.watermark()]);
        if (!alive) return;
        setLocalCount(n);
        setLocalWatermark(wm);
        setDiag(eng.diagnostics());
      } catch {
        /* 未登录/未配对时忽略 */
      }
    };
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    authApi
      .me()
      .then((r) => {
        setUsername(r.username);
        setNickname(r.nickname ?? '');
        setAvatar(r.avatar);
      })
      .catch(() => setUsername(''));
  }, []);

  function comingSoon(what: string) {
    setNotice(`${what} 即将开放。`);
    setTimeout(() => setNotice(''), 2500);
  }

  function logout() {
    void authApi.logout().catch(() => {});
    clearToken();
    window.location.reload();
  }

  /** 强制全量同步:归零游标 + 清空水位 → 本机全部重推、并从流头全量拉取(数据对不上时用)。 */
  async function fullResync() {
    setBusy(true);
    setNotice('正在全量同步…');
    try {
      setLastSyncAt('');
      setRelayCursor(0);
      const r = await relaySyncNow();
      setNotice(`同步完成:推送 ${r.pushed} 条,拉取合并 ${r.pulled} 条。`);
    } catch (e) {
      setNotice(`同步失败:${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const options: Array<{ label: string; desc: string; onClick: () => void; danger?: boolean }> = [
    { label: '修改个人信息', desc: '头像 / 昵称 / 账号', onClick: () => setShowSettings(true) },
    { label: '绑定邮箱', desc: '找回密码 / 解绑', onClick: () => setShowSettings(true) },
    { label: '重置密码', desc: '当前密码 + 新密码', onClick: () => setShowSettings(true) },
    { label: '绑定微信', desc: '微信扫码登录(即将开放)', onClick: () => comingSoon('绑定微信') },
    { label: '绑定手机号', desc: '手机号登录(即将开放)', onClick: () => comingSoon('绑定手机号') },
    { label: 'AI 陪伴', desc: '读过你的日记,陪你聊', onClick: () => setShowCompanion(true) },
    { label: '数据备份 / 迁移', desc: '导出/导入迁移包', onClick: () => setShowSettings(true) },
    { label: '导出日记', desc: 'Markdown / JSON', onClick: () => window.open(exportUrl()) },
    {
      label: '强制全量同步',
      desc: busy ? '同步中…' : '数据对不上时点这里(重推全部 + 从头全量拉取)',
      onClick: () => void fullResync(),
    },
    { label: '退出登录', desc: '', onClick: logout, danger: true },
  ];

  return (
    <div className="view">
      <h1 className="view-title">我的</h1>

      <div className="mine-account">
        {avatar ? (
          <div className="mine-avatar-img"><ResolvedImage src={avatar} alt="头像" /></div>
        ) : (
          <div className="mine-avatar">{(nickname || username || '?').slice(0, 1).toUpperCase()}</div>
        )}
        <div className="mine-account-main">
          <div className="mine-username">{nickname || username || '未登录'}</div>
          <div className="mine-sub">@{username} · 本地优先 · 日记只在你自己的设备上</div>
        </div>
      </div>

      <div className="mine-options">
        {options.map((o) => (
          <button key={o.label} className="mine-row" onClick={o.onClick}>
            <span className="mine-row-label">{o.label}</span>
            <span className="mine-row-desc">{o.desc}</span>
          </button>
        ))}
      </div>

      {notice && <p className="ok" style={{ textAlign: 'center' }}>{notice}</p>}

      <p className="mine-version">
        版本 v{__APP_VERSION__} · 唤醒通道 {channel === 'ws' ? 'WebSocket' : '长轮询(兜底)'}
        {localCount !== null && (
          <>
            <br />
            本机 {localCount} 条 · 最后更新 {localWatermark ? new Date(localWatermark).toLocaleString('zh-CN', { hour12: false }) : '(空)'}
          </>
        )}
        {diag && (
          <>
            <br />
            上次同步 {diag.lastSyncAt ? new Date(diag.lastSyncAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'} · 收件 {diag.lastHandled} 条
            {diag.lastError && (
              <span style={{ color: '#c0392b' }}>
                {' '}
                · 最近错误 {diag.lastErrorAt ? new Date(diag.lastErrorAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''}
                :{diag.lastError}
              </span>
            )}
          </>
        )}
      </p>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showCompanion && <CompanionModal onClose={() => setShowCompanion(false)} />}
    </div>
  );
}
