import { getSyncKey, getSyncPartner, isPhoneMode, relaySyncNow, syncNow, setLastSyncAt } from '../api';

let syncing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * 自动同步(登录/打开 App 时):**全量**。
 * 先清空本机同步水位 → 把本地全部日记推给中继、并拉取对端全部(增量+消费导致的"数据丢失/换机"因此能自动找回)。
 * 无需手动点"同步":打开即同步。优先点对点直连,不可达自动降级为经中继(P2)。
 */
export async function autoSync(): Promise<void> {
  if (!isPhoneMode() || !getSyncKey() || syncing) return;
  syncing = true;
  try {
    setLastSyncAt(''); // 登录/打开=全量:清水位→推全部/拉全部
    await doSync();
  } catch {
    /* 都不可达/离线:静默 */
  } finally {
    syncing = false;
  }
}

/** 实际同步:有配对地址走点对点,否则走云端密文中继。 */
async function doSync(): Promise<void> {
  if (getSyncPartner()) {
    try {
      await syncNow(); // 点对点直连
      return;
    } catch {
      /* 点对点不可达 → 走中继 */
    }
  }
  await relaySyncNow();
}

/** 内容有变化后,延迟触发一次自动同步(去抖,增量)。 */
export function scheduleSync(delay = 1200): void {
  if (!isPhoneMode() || !getSyncKey()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      if (syncing) return;
      syncing = true;
      try {
        await doSync();
      } catch {
        /* 静默 */
      } finally {
        syncing = false;
      }
    })();
  }, delay);
}
