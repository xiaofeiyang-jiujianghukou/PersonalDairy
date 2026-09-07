import { getSyncPartner, isPhoneMode, syncNow } from '../api';

let syncing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 单向自动同步:手机本地优先、已配对、且当前未在同步时,执行一次增量同步(双向)。 */
export async function autoSync(): Promise<void> {
  if (!isPhoneMode() || !getSyncPartner() || syncing) return;
  syncing = true;
  try {
    await syncNow();
  } catch {
    /* 离线/不可达/未配对手动安装时静默;不打扰用户 */
  } finally {
    syncing = false;
  }
}

/** 内容有变化后,延迟触发一次自动同步(去抖,避免连续保存狂发请求)。 */
export function scheduleSync(delay = 1200): void {
  if (!isPhoneMode() || !getSyncPartner()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void autoSync();
  }, delay);
}
