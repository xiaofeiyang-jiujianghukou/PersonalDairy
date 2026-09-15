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
| `POST /api/relay/notify` | "我更新到 xxxa"（广播，元数据）—— **直投**给在线端 |
| `POST /api/relay/need` | "把 origin 在 (from, to] 的数据给我"（定向，元数据） |
| `POST /api/relay/push` | 推数据（`kind:'data'`，`to` 定向或空=广播），载荷为密文，**直投**给在线端 |

Redis 结构（**每账号只有这一项**）：

```
trans:{uid}:reg   多端状态：deviceId → {watermark, vector, count, loginAt, lastSeen}
```

**服务端零存储**：
- 数据由服务端在两台设备之间**用 WebSocket 直接转发**，不落任何存储（没有信箱、没有消息队列）；
- 只投给**此刻在线**的端；离线端收不到任何东西（"在线即同步，离线不同步"）；
- 中转的载荷是端到端密文，服务端不解密、不读内容；
- 历史遗留的旧 key（`events/seq/offset/devices` 共享消息日志，以及上一版的 `mbox` 信箱）
  在服务端启动时由 `cleanupLegacyKeys()` 自动清理，不需要人工记。

### 为什么没有游标（重要）
需求方的模型是**纯时间区间驱动**：看到对端水位更高 → 只索取那段时间的数据。
"读到第几条"（游标）是**消息日志的传输层位置**，与"该同步什么数据"无关。
曾经因为它产生了真实故障：服务端会过滤掉"不是我自己的/定向给别人的"消息，
客户端却用"这一页有几条"判断是否读完 → 游标被钉死、数据永远追不上。

现在连"队列"本身都不需要了：
- 有缺口 → 发 `need` → 对端把该区间**直投**回来，收到即合并；
- 请求没被应答（对端不在线）→ **不做任何排队**；对端上线时 `hello` 会向其它在线端广播
  "有端加入"，它们反向比对自己的水位向量、主动来索取 —— **谁在线谁先补，最终仍收敛**。

## 5. 数据通道：WebSocket（既传数据，也是在线的唯一判据）

**定位**：WebSocket **就是数据通道**。服务端把信封（notify / need / 加密数据）**直接推过来**，
客户端收到即交给引擎解密合并 —— 这就是"我这边写完，你那边秒级收到"。
没被推到的（对端不在线、或自己不在线），靠重连成功后的一次完整对账补齐。

### 5.1 连接与帧
```
客户端 → POST /api/relay/ws-ticket   (Bearer 鉴权, 带 deviceId)
        ← { ticket, expiresIn: 60 }
客户端 → GET  /api/relay/ws?ticket=… (WebSocket 升级)
        ← {"type":"ready"}                              连接建立
        ← {"type":"mail","envelope":{…}}                直投一个信封(小)
        ← {"type":"mail","chunk":{id,seq,total,data}}   大信封分帧(客户端重组后再交给引擎)
        ← {"type":"ping","at":…}                        应用层心跳(客户端据此发现"连接悄悄死了")
```

- **在线判据**：连接即在线；超过 40 秒没收到应用层心跳就断开（手机被系统冻结时不再虚报在线）。
  设备表里的 `online` 直接取自"有没有这条连接"，比用 `lastSeen` 推断更准。
- **大信封分帧**：单帧上限 256K 字符，超过就切帧发送，客户端重组 —— 业务层（信封/加密/合并）完全无感。
- **没有长轮询兜底**：没有信箱，轮询无从拉起数据；连接断了就等重连 + 对账。

- **为什么用票据**:浏览器/WebView 的 `WebSocket` **不能带自定义请求头**(无法发 `Authorization`),
  直接 `?token=` 会让长期 token 进 nginx 日志 → 改为"Bearer 换一次性票据"(60 秒过期、**用后即焚**、绑定账号+设备)。
- **在线状态**:连接建立即视为在线,之后每个 pong(30 秒)刷新 —— 比"靠上报"更准。
- **存活检测**:服务端每 30 秒 `ping`,一个周期内没有 `pong` 即判定半开连接并 `terminate()`
  (手机切网/NAT 超时后 TCP 可能"看起来还在")。
- **定向**:`to` 指向某设备时只唤醒该设备的 socket;发送方自己的 socket 不会被唤醒。
- **同设备重复连接**:新连接替换旧连接(旧连接以 4409 关闭)。

### 5.2 没有长轮询兜底（刻意的）
WebSocket 是**唯一**的数据通道，所以 nginx **必须**配好 `Upgrade`（见 5.4）——
配不好就是"连不上 = 完全同步不了"，而不是"退化成慢一点"。
这是"服务端零存储"的直接代价：没有信箱，就没有任何地方能"稍后再取"。

### 5.3 断线与重连
| 触发 | 动作 |
|---|---|
| `onclose` / `onerror` | 指数退避重连(1→2→5→10→20→30 秒封顶);连接曾稳定存活 >10 秒则重置退避 |
| 重连成功 | **立即做一次完整对账**(hello + 按需补传),补齐断线期间错过的变化 |
| App 回到前台 | 立即重连(`reconnectNow`,不等退避)+ 一次完整对账 |
| 网络恢复(`online`) | 同上 |

### 5.4 nginx 必须加的三行
```nginx
location /api/relay/ws {
    proxy_pass http://127.0.0.1:4520;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # ← 缺这三行 WS 会握手失败
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;                    # 长连接不能被 60s 默认超时掐断
    proxy_send_timeout 3600s;
}
```
> **这段现在是必须的**：WS 就是数据通道，握手失败 = 完全同步不了（不再是"慢一点"）。

## 6. 客户端在线策略（纯事件驱动，无定时轮询）

| 触发（事件） | 动作 |
|---|---|
| 服务端直投来信封 | WS 收到 `{type:'mail'}` → 交给引擎 `receive()`：解密 → 合并 → 刷新界面 |
| 登录 / 冷启动 | `autoSync()`：先连 WS，再 hello 握手 → 按需索取缺口 → 广播本端水位 |
| WS 首次连上 / 重连成功 | 立即完整对账一次（补齐断线期间错过的变化） |
| 收到某个端的 notify / "有端加入" | 按**来源**逐条比对水位向量 → 定向索取缺口（条目数更多则要一次全量） |
| 收到某个端的 need | 把 origin 在 (from, to] 的数据分小批**直投**给它 |
| 本端写入 | 去抖 800ms → notify + 广播增量（对端收到会来索取区间） |
| App 回到前台 / 网络恢复 | 重连 + 完整对账一次（`visibilitychange` / `online`） |

**没有 `setInterval` 定时轮询，也没有长轮询常驻**：唯一的常驻连接是 WebSocket。
"回前台 / 网络恢复"这两个**真实事件**用来兜住"连接被系统静默掐断"的情况。

## 7. 自测（可复现）

```bash
# 起测试用 Redis（独立端口，不动生产）
docker run -d --rm --name dsh-redis-sync -p 6399:6379 redis:alpine

# 直投协议自测：会起一个独立服务（随机端口 + 临时数据目录），用 SyncEngine + 真 WebSocket 模拟多台设备
pnpm --filter @diary/server test:relay
```

覆盖：场景 1（在线即实时，全程无轮询）、场景 2（离线不投 + 上线对账补齐）、
场景 3（大信封分帧 + 客户端重组）、场景 4（三端收敛 + 主端选举）、
场景 5（2099 墓碑不顶高水位）、场景 6（AI 对话直投 + 幂等）。13 项断言全绿。

跑完可以顺手确认**服务端零存储**：
```bash
redis-cli -p 6399 --scan          # 只会有 trans:{uid}:reg，没有任何 mbox / events
```

WS 通道自测（20 项：票据鉴权/一次性/伪造被拒、直投投递、定向不误投、不叫醒自己、
应用层心跳超时、在线/离线投递语义）：
```bash
pnpm --filter @diary/server test:ws
```

> 部署后另有云端自检：
> `DIARY_USER=账号 DIARY_PASS=密码 pnpm --filter @diary/server check:cloud`

## 8. 部署（服务端）
```bash
cd /deploy/PersonalDairy
git pull
pnpm install            # ← 本次新增了依赖 @fastify/websocket,这一步不能省
pm2 restart diary-server
```
另外把 §5.4 的 nginx 片段加到站点配置里,然后 `nginx -t && systemctl reload nginx`。
