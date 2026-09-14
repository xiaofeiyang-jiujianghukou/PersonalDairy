import { useEffect, useState } from 'react';
import { onSyncStatus, type SyncStatus } from '../lib/syncStatus';

/**
 * 同步提示:发现落后 → 显示「同步中…」;数据到齐 → 显示「同步成功 N 条」,3 秒后自动消失。
 * 只在有同步动作时出现,平时不占任何空间。
 */
export default function SyncToast() {
  const [status, setStatus] = useState<SyncStatus>({ kind: 'idle' });
  const [visible, setVisible] = useState(false);

  useEffect(() => onSyncStatus(setStatus), []);

  useEffect(() => {
    if (status.kind === 'idle') {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (status.kind !== 'done') return; // 同步中:不自动消失
    const t = setTimeout(() => setVisible(false), 3000); // 完成后 3 秒消失
    return () => clearTimeout(t);
  }, [status]);

  if (!visible || status.kind === 'idle') return null;
  const text = status.kind === 'syncing' ? '同步中…' : `同步成功 ${status.merged} 条数据`;
  return (
    <div className={`sync-toast${status.kind === 'syncing' ? ' busy' : ''}`} role="status">
      {status.kind === 'syncing' && <span className="sync-toast-dot" />}
      {text}
    </div>
  );
}
