import { Fragment, useEffect, useState } from 'react';
import { api, authApi, clearToken, exportUrl, relayDevices, relaySyncNow, setLastSyncAt, setRelayCursor } from '../api';
import { getSyncEngine } from '../api';
import { getSyncChannel } from '../lib/syncAuto';
import { getDeviceId } from '../lib/device';
import SettingsModal from '../components/SettingsModal';
import LogViewerModal from '../components/LogViewerModal';
import CompanionModal, { type CompanionMode } from '../components/CompanionModal';
import MentorReportModal from '../components/MentorReportModal';
import ResolvedImage from '../components/ResolvedImage';

export default function MyView({ onOpenDay }: { onOpenDay: (date: string) => void }) {
  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [chatMode, setChatMode] = useState<CompanionMode | null>(null);
  const [showMentor, setShowMentor] = useState(false);
  const [showTerminals, setShowTerminals] = useState(false); // 我的终端默认收起
  const [showLogs, setShowLogs] = useState(false); // 日志管理
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // 本机同步自查状态(全部读本地,不发网络请求):通道 / 本机条目数 / 水位 / 上次同步
  const [channel, setChannel] = useState<'ws' | 'offline'>(getSyncChannel());
  const [localCount, setLocalCount] = useState<number | null>(null);
  const [localWatermark, setLocalWatermark] = useState('');
  const [diag, setDiag] = useState<{ lastSyncAt: string; lastError: string; lastErrorAt: string; lastHandled: number } | null>(null);
  const [peers, setPeers] = useState<Array<{ deviceId: string; online: boolean; count: number; watermark: string }>>([]);
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
        try {
          setPeers(await relayDevices());
        } catch {
          /* 拿不到就不显示 */
        }
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
    { label: 'AI 陪伴', desc: '读过你的日记,陪你聊', onClick: () => setChatMode('companion') },
    {
      label: 'AI 心理导师',
      desc: '近况面板 + 免费心理疏导对话(不做诊断)',
      onClick: () => setShowMentor(true),
    },
    { label: '数据备份 / 迁移', desc: '导出/导入迁移包', onClick: () => setShowSettings(true) },
    { label: '导出日记', desc: 'Markdown / JSON', onClick: () => window.open(exportUrl()) },
    {
      label: '强制全量同步',
      desc: busy ? '同步中…' : '数据对不上时点这里(重推全部 + 从头全量拉取)',
      onClick: () => void fullResync(),
    },
    { label: '日志管理', desc: '写日记 / 通知 / 水位 / 区间 / 错误', onClick: () => setShowLogs(true) },
    { label: '退出登录', desc: '', onClick: logout, danger: true },
  ];

  // 收起时也能一眼看到概况:几台在线、合计多少条
  const visiblePeers = peers.filter((d) => {
    const isSelf = d.deviceId === getDeviceId();
    return isSelf || d.online || d.count > 0 || Boolean(d.watermark);
  });
  const onlineCount = visiblePeers.filter((d) => d.online).length;
  const counts = visiblePeers.map((d) => d.count);
  const minC = counts.length ? Math.min(...counts) : 0;
  const maxC = counts.length ? Math.max(...counts) : 0;
  // 本机是否持有最新数据(是的话,其它终端应该来向本机拉)
  const selfWatermark = peers.find((d) => d.deviceId === getDeviceId())?.watermark ?? '';
  const newestWatermark = peers.reduce((m, d) => (d.watermark > m ? d.watermark : m), '');
  const selfIsNewest = Boolean(selfWatermark) && selfWatermark >= newestWatermark;

  // 摘要回答一个真正关心的问题:各终端是否一致(收敛)
  const termSummary = visiblePeers.length
    ? `${onlineCount} 台在线 · ${minC === maxC ? `已一致 ${maxC} 条` : `未一致 ${minC}~${maxC} 条`}`
    : '';
    // 终端管理区块(默认收起,点标题展开)
  const terminalsSection = peers.length > 0 && (
    <div className="mine-section">
        <button
        type="button"
        className="mine-section-title as-toggle"
        onClick={() => setShowTerminals((v) => !v)}
        >
        <span>终端管理</span>
        <span className="mine-section-summary">
          {termSummary}
          <span className={`chevron${showTerminals ? ' open' : ''}`}>›</span>
        </span>
        </button>
        {showTerminals && peers
        .filter((d) => {
          // 隐藏"僵尸终端":没有任何数据、又不在线 —— 多半是排查/自检留下的临时设备号
          const isSelf = d.deviceId === getDeviceId();
          return isSelf || d.online || d.count > 0 || Boolean(d.watermark);
        })
        .slice()
        // 本机永远排第一,其余按"在线优先 + 设备号"排序
            .sort((a, b) => {
              const self = getDeviceId();
              const aSelf = a.deviceId === self ? 1 : 0;
              const bSelf = b.deviceId === self ? 1 : 0;
              if (aSelf !== bSelf) return bSelf - aSelf;
              return Number(b.online) - Number(a.online) || a.deviceId.localeCompare(b.deviceId);
            })
        .map((d) => {
          const isSelf = d.deviceId === getDeviceId();
          return (
            <div key={d.deviceId} className="mine-row as-div">
            <span className="mine-row-label">
              {isSelf ? '本机' : d.deviceId.slice(0, 8)}
              {isSelf && <span className="mine-badge online" style={{ marginLeft: 8 }}>这台</span>}
            </span>
            <span className="mine-row-desc">
              {d.count} 条 · 最新 {d.watermark ? new Date(d.watermark).toLocaleString('zh-CN', { hour12: false }) : '无数据'}
            </span>
            <span className={`mine-badge${d.online ? ' online' : ''}`}>{d.online ? '在线' : '离线'}</span>
            </div>
          );
        })}
        {username && (
          <div className="mine-section-foot">
            <button
              type="button"
              className="link-btn"
              onClick={async () => {
                if (!window.confirm('清理无数据且长期离线的终端记录?(不会删除任何日记)')) return;
                try {
                  const r = await api.forgetStaleTerminals(getDeviceId(), true);
                  setNotice(r > 0 ? `已清理 ${r} 条失效终端记录` : '没有需要清理的记录');
                  setPeers(await relayDevices());
                } catch (e) {
                  alert((e as Error).message);
                }
              }}
            >
              清理失效终端
            </button>
          </div>
        )}
    </div>
  );
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
        {options.map((o, i) => (
          <Fragment key={o.label}>
            <button className="mine-row" onClick={o.onClick}>
              <span className="mine-row-label">{o.label}</span>
              <span className="mine-row-desc">{o.desc}</span>
            </button>
            {/* 终端管理:紧跟「修改个人信息」之后 */}
            {i === 0 && terminalsSection}
          </Fragment>
        ))}
      </div>

      {notice && <p className="ok" style={{ textAlign: 'center' }}>{notice}</p>}

      <p className="mine-version">
        版本 v{__APP_VERSION__} · 通道 {channel === 'ws' ? 'WebSocket(实时)' : '未连接'}
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
      {showLogs && <LogViewerModal onClose={() => setShowLogs(false)} />}
      {chatMode && <CompanionModal mode={chatMode} onClose={() => setChatMode(null)} />}
      {showMentor && <MentorReportModal onClose={() => setShowMentor(false)} />}
    </div>
  );
}
