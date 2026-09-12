# 多端同步协议（PersonalDiary）

> 服务端只做三件事：**身份**、**加密中继**、**AI**。日记内容永远只在终端之间以密文流动。
> 协议实现：`packages/shared/src/syncEngine.ts`（与宿主解耦，浏览器 / Node / 测试共用）
> 服务端控制面：`apps/server/src/index.ts` 的 `/api/relay/*`，注册表在 `apps/server/src/relayRedis.ts`

## 0. 名词

| 名词 | 含义 |
|---|---|
| `deviceId` | 每台设备的稳定标识（`lib/device.ts`，持久化在 localStorage）。同时用于：排除自己推的消息、定向投递、主端选举、**条目溯源** |
| 水位 `watermark` | 本端已知的最新更新时间点（本地全部条目 `updatedAt` 的最大值，ISO 字符串，可直接比大小） |
| **水位向量** `vector` | `{ 来源deviceId → 我拥有的该来源最新 updatedAt }`。**这是收敛的关键**，见 §2 |
| `count` | 本端条目数（含墓碑）。用于"数量对不上就补全"的兜底 |

## 1. 三种场景（与需求一一对应）

### 场景 1：任一端写入 → 在线端收敛
```
A 写入 ──► ① POST /api/relay/notify { watermark: xxxa, vector, count }
              （广播"我更新到 xxxa"；只有时间元数据，无日记内容）
B 收到 ──► ② 计算自己 xxxb：xxxb < xxxa ⇒ POST /api/relay/need
              { to: A, origin, fromWatermark: xxxb, toWatermark: xxxa }（定向给 A）
A 收到 ──► ③ 取本地 (xxxb, xxxa] 的条目，按 192KB 分小批加密后
              POST /api/relay/push { to: B, kind: 'data' }
B      ──► ④ GET /api/relay/pull 拉取、解密、LWW 合并
```

### 场景 2：新端登录（已有端在线）
```
C 登录 ──► POST /api/relay/hello { watermark, vector, count }
       ◄── { leader, devices: [{ deviceId, watermark, vector, count, online }] }
C      ──► 凡是"对方有我没有 / 对方比我新"的来源，逐一向水位更高的端
              （主端优先）发 need 请求区间补传 → 同场景 1 的 ③④
```

### 场景 3：多端同时上线
```
D/E/F 各自 hello ──► 服务端选举主端：
        ① 水位最新者优先；② 水位相同取 loginAt 更早者；③ 仍相同按 deviceId 稳定排序
各端 ──► 按来源比对水位向量，向"水位更高者 / 主端"索取区间
      ──► 最终所有端收敛到同一份数据（自测场景 3 验证）
```
> 登录存在**注册竞态**（同时上线时各自的 hello 可能只看到部分设备）。
> 解决方式**不是定时轮询**：服务端在 `hello` 时向其它在线端**广播一条"有端加入"**
> （带该端的水位 / 水位向量 / 条目数），老端收到就立刻按来源比对并索取缺口。
> 因此多端同时上线也能在没有周期性对账的前提下收敛（自测场景 3 验证）。

## 2. 为什么必须用"水位向量"而不是单一水位

单一水位只能说"我最新的一条是什么时候的"。若 A 缺的是**比你最新那条更早**的数据，
对方会以为"你都有"——水位比较发现不了缺口。

真实例子：D 有 t1 的数据、E 有 t2、F 有 t3（互不知情，t1<t2<t3）。
- 只比单一水位：D 看到 F 新 → 拉 (t1,t3] → 拿到 t3 的那条，**仍然没有 E 的 t2**（因为它在区间外）。
- 用水位向量：按**来源**逐个比 → D 发现"我没有 E 这个来源的任何数据" → 向 E 索取 (—, t2] ✅

所以区间是**按来源**索取的：`need(origin, fromWatermark, toWatermark]`。

## 3. 两个兜底（都是真实缺陷驱动）

1. **兼容广播**：旧版本客户端只会拉广播数据、不会发 `need`。所以写入端在 notify 之外，
   还会把"上次广播之后的新条目"（`pushedAt` 之后）分小批**广播**到中继 —— 旧客户端照常能收到，
   新设备即使没有在线对端也能从中继恢复近期数据。
2. **条目数兜底**：历史数据的来源标记可能不准（早期 `deviceId` 被写死为 `'phone'`），
   此时水位向量会"看起来已满足"。因此 `hello` 会交换 `count`：**对方条目数更多 ⇒ 向它要一次全量**
   （`origin=''` + `fromWatermark=''`）。自测场景 4 覆盖。

## 4. 消息与接口

| 接口 | 作用 |
|---|---|
| `POST /api/relay/hello` | 注册/登录握手：上报水位+向量+条目数，返回设备表与主端；**并向其它在线端广播"有端加入"** |
| `POST /api/relay/heartbeat` | 心跳（幂等刷新 `lastSeen` 与水位，不改 `loginAt`） |
| `GET  /api/relay/devices` | 只读设备表 + 主端 |
| `POST /api/relay/notify` | "我更新到 xxxa"（广播，元数据） |
| `POST /api/relay/need` | "把 origin 在 (from, to] 的数据给我"（定向，元数据） |
| `POST /api/relay/push` | 推数据（`kind:'data'`，`to` 定向或空=广播），载荷为密文 |
| `GET  /api/relay/pull` | 按游标拉取（自动过滤：不回自己的、跳过定向给别人的） |
| `POST /api/relay/wait` | 长轮询实时唤醒（毫秒级；不用 XREAD BLOCK，避免占用共享连接） |

Redis 结构（每账号一套）：

```
trans:{uid}:events        Redis Stream，消息带 kind(data|notify|need) 与 to(定向)，ID = <seq>-0
trans:{uid}:seq           顺序号分配
trans:{uid}:offset:{dev}  每端消费游标（30 天过期）
trans:{uid}:devices       终端集合（用于"全部消费后删除"）
trans:{uid}:reg           终端注册表：deviceId → {watermark, vector, count, loginAt, lastSeen}
```

## 5. 客户端在线策略（纯事件驱动，无定时轮询）

| 触发（事件） | 动作 |
|---|---|
| 登录 / 冷启动 | `autoSync()`：hello 握手 → 按需补传 → 拉净 |
| 服务端有新消息 | 长轮询被唤醒（服务端挂起，有新消息才返回）→ 拉取并处理 notify / need / 数据 |
| 收到某个端的 notify / "有端加入" | 按**来源**逐条比对水位向量 → 定向索取缺口（条目数更多则要一次全量） |
| 收到某个端的 need | 把 origin 在 (from, to] 的数据分小批推给它 |
| 本端写入 | 去抖 800ms → notify + 广播增量 + 拉一次 |
| App 回到前台 / 网络恢复 | 完整对账一次（`visibilitychange` / `online`） |

**没有 `setInterval` 定时轮询**：唯一的常驻连接是长轮询（没有新消息时服务端不返回）。
"回前台 / 网络恢复"这两个**真实事件**用来兜住"长轮询连接被系统静默掐断"的情况。

## 6. 自测（可复现）

```bash
# 起测试用 Redis（独立端口，不动生产）
docker run -d --rm --name dsh-redis-sync -p 6399:6379 redis:alpine

# 跑自测：会起一个独立服务（随机端口 + 临时数据目录），用 SyncEngine 模拟多台设备
pnpm --filter @diary/server test:sync
```

覆盖：场景 1（在线实时）、场景 2（新端补传）、场景 3（多端同时上线 + 主端选举）、
场景 4（条目数兜底）、场景 5（旧客户端兼容）。

自测里**刻意不做任何定时对账**（只收消息 + 响应事件），因此 17 项断言全绿即证明
收敛不依赖周期性轮询。可重复运行。

> 部署后另有一条云端自检：
> `DIARY_USER=账号 DIARY_PASS=密码 pnpm --filter @diary/server check:cloud`
