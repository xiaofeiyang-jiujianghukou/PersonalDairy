/**
 * 本机设备标识(全局唯一,持久化)。
 *
 * 用途:
 *   - 中继同步:每台设备一个 deviceId,用于排除自己推送的消息、定向投递、主端选举;
 *   - 条目溯源:每条日记记下"我是哪台设备创建/修改的"(deviceId),
 *     同步协议据此维护"按来源设备的水位向量",才能发现"我缺了某台设备的哪批数据"。
 *
 * 注意:这个值必须是**真实设备**的标识,不能写死(曾经写死成 'phone',
 * 导致电脑端写的条目也被标成手机来源 → 水位向量失真 → 多端可能漏同步)。
 */
const DEVICE_ID_KEY = 'diary.deviceId';

let cached = '';

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* 忽略 */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 读取(必要时生成并持久化)本机 deviceId。 */
export function getDeviceId(): string {
  if (cached) return cached;
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY) ?? '';
    if (!id) {
      id = genId();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    cached = id;
    return id;
  } catch {
    // 无 localStorage(测试/隐私模式)→ 进程内临时标识
    if (!cached) cached = genId();
    return cached;
  }
}
