import { getSyncKey, getSyncPartner, isPhoneMode, relaySyncNow, syncNow } from '../api';

let syncing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * 自动同步:手机本地优先、已有同步密钥、且未在同步时。
 * 优先「点对点直连」(已配对且可达);不可达则自动降级为「经中继」同步(P2)。
 */
export async function autoSync(): Promise<void> {
  if (!isPhoneMode() || !getSyncKey() || syncing) return;
  syncing = true;
  try {
    if (getSyncPartner()) {
      try {
        await syncNow(); // 直接与配对设备同步
        return;
      } catch {
        /* 点对点不可达 → 走中继 */
      }
    }
    await relaySyncNow(); // 经服务端密文中继(跨网络)
  } catch {
    /* 都不可达/离线:静默,不打扰用户 */
  } finally {
    syncing = false;
  }
}

/** 内容有变化后,延迟触发一次自动同步(去抖)。 */
export function scheduleSync(delay = 1200): void {
  if (!isPhoneMode() || !getSyncKey()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void autoSync();
  }, delay);
}
