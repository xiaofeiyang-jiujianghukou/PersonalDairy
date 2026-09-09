import { useEffect, useState } from 'react';
import { authApi, clearToken, exportUrl } from '../api';
import SettingsModal from '../components/SettingsModal';
import CompanionModal from '../components/CompanionModal';

export default function MyView({ onOpenDay }: { onOpenDay: (date: string) => void }) {
  const [username, setUsername] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showCompanion, setShowCompanion] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    authApi
      .me()
      .then((r) => setUsername(r.username))
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

  const options: Array<{ label: string; desc: string; onClick: () => void; danger?: boolean }> = [
    { label: '修改个人信息', desc: '用户名 / 邮箱', onClick: () => setShowSettings(true) },
    { label: '重置密码', desc: '当前密码 + 新密码', onClick: () => setShowSettings(true) },
    { label: '绑定微信', desc: '微信扫码登录(预留)', onClick: () => comingSoon('绑定微信') },
    { label: '绑定手机号', desc: '手机号登录(预留)', onClick: () => comingSoon('绑定手机号') },
    { label: 'AI 陪伴', desc: '读过你的日记,陪你聊', onClick: () => setShowCompanion(true) },
    { label: '数据备份 / 迁移', desc: '导出/导入迁移包', onClick: () => setShowSettings(true) },
    { label: '导出日记', desc: 'Markdown / JSON', onClick: () => window.open(exportUrl()) },
    { label: '退出登录', desc: '', onClick: logout, danger: true },
  ];

  return (
    <div className="view">
      <h1 className="view-title">我的</h1>

      <div className="mine-account">
        <div className="mine-avatar">{(username || '?').slice(0, 1).toUpperCase()}</div>
        <div className="mine-account-main">
          <div className="mine-username">{username || '未登录'}</div>
          <div className="mine-sub">本地优先 · 日记只在你自己的设备上</div>
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

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showCompanion && <CompanionModal onClose={() => setShowCompanion(false)} />}
    </div>
  );
}
