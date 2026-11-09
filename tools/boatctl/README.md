# boatctl · 上位机自动化工具

面向"没有人手动点界面"的场景：让脚本（或agent）能够自己连串口、自己采数据、自己判断哪里坏了。

零依赖：只用 Node 内置模块（Node 22+ 自带全局 `WebSocket`）。

---

## 为什么走 WebUI 而不直接开串口

串口是独占资源。WebUI 已经是一个成熟且经过验证的串口 owner（拆行、脏字节清洗、多 JSON 提取、
采样状态机都在里面）。如果 boatctl 再抢一次串口，两边会互相踢掉，而且要把那些解析逻辑重写一遍。

所以架构是：

```
船 --LoRa--> USB串口 --(唯一 owner)--> WebUI(server.js) --HTTP + WebSocket--> boatctl
```

代价：必须先启动 WebUI。收益：只有一处解析逻辑，boatctl 只做"驱动 + 判定"。

---

## 快速开始

```bash
# 1. 先起 WebUI（串口在它手里）
cd WebUI && npm start

# 2. 用 boatctl 驱动
node tools/boatctl/bin/boatctl.js ports
node tools/boatctl/bin/boatctl.js selftest --open COM7
node tools/boatctl/bin/boatctl.js watch
```

Windows 下建议先 `cd tools/boatctl`，后面的命令可以简写成 `node bin/boatctl.js ...`。

---

## 命令

| 命令 | 说明 |
|---|---|
| `ports` | 列出串口 |
| `status [--json]` | 打印当前状态快照 |
| `watch [--duration 15s]` | 实时滚屏，含主循环周期列 |
| `send <json>` | `--file x.json` | `- (stdin)` | 发送任意下行 JSON |
| `cmd <stop\|start\|sensor>` | 快捷指令 |
| `motor <l> <r>` | 直接设置左右 PWM |
| `selftest [--open COMx] [--duration 15s] [--out r.json]` | **全自动自检** |
| `record --out x.jsonl [--duration 60s]` | 录制遥测到 JSONL |
| `analyze x.jsonl [--json]` | 离线分析录制文件 |
| `sim [--port 3311] [--loop-ms 1000] [--gps] [--no-temp] [--no-imu] [--no-ph]` | 模拟桥（无硬件自测） |

全局：`--url http://127.0.0.1:3000`、`--json`。

退出码统一：`0` 通过 / `1` 有失败项 / `2` 参数错误。可以直接用作 CI 或脚本判断。

### PowerShell 引号坑

PowerShell 会吞掉参数里的双引号，所以：

```powershell
# 不推荐
node bin/boatctl.js send '{"t":"cmd","cmd":"stop"}'

# 推荐
'{"t":"cmd","cmd":"stop"}' | node bin/boatctl.js send -
node bin/boatctl.js send --file cmd.json
```

---

## 自检判定项

`selftest` 采集一个窗口后，输出结构化结论。判定逻辑在 `src/analyzer.js`，阈值集中在
`THRESHOLDS` 里，需要时单点调整。

| id | 判据 | fail 的含义 |
|---|---|---|
| `link` | 收到帧 | LoRa 链路/波特率/固件未运行 |
| `loop` | `ms` 差值均值 ∈ [900,1150] | **主循环被阻塞**——本项目的历史顽疾，导航 PID 在此节奏下无法工作 |
| `seq` | seq 跳号比例 | LoRa 丢包或缓冲区溢出 |
| `ph` | `phr` ∈ [200,16300] 且 ≠0 | 电极未接或 ADC 未启动 |
| `temp` | `tv=1` 占比 ≥ 0.8 | DS18B20 接线、4.7k 上拉或探头损坏 |
| `imu` | `ia` 在增长 | USART2 波特率或 ATKP 帧校验 |
| `gps` | fix>0 | **只 warn**：室内无定位属预期 |
| `ai` | 有 `aiph` 字段 | EdgeAI 初始化失败 |

GPS 被刻意降级为 warning —— 室内调试不该被它挡住。

---

## 库 API（写脚本时用这个）

```js
const { BoatClient } = require('./src/client');
const { analyze } = require('./src/analyzer');

const c = new BoatClient({ url: 'http://127.0.0.1:3000' });
await c.connect();                       // 建 WebSocket，等首帧 snapshot

c.on('telemetry', (t) => { /* 已解码 */ });
const now = c.latest;                    // 最新一帧
await c.collect(5000);                   // 采集 5 秒
await c.waitFor((t) => t.fix > 0, 10000); // 等到定位，超时返回 null

await c.cmd('stop');
await c.motor(50, 50);
await c.mcal(1.0, 0.85, 0, 10);
await c.send({ t: 'target', lat: 345001000, lon: 1040001000, r: 5, ar: 1, rr: 8 });
await c.targetZone('zone_A');
await c.cancelTask();
await c.close();
```

解码后的 `t` 字段（完整定义见 `src/decode.js`）：

```
seq, uptimeMs, rxAt
ph, phRaw, phMv
tempC, tempValid
fix, satellites, lat, lon
imuValid, roll, pitch, yaw, imuRxBytes, imuFrames
navState, navStateName, distanceM, headingErrorDeg
boundaryState, boundaryDistanceM, returnState, returnDistanceM
crossTrackM, correctedHeadingDeg
aiPhSimilarity, aiPhNormal, aiTempSimilarity, aiTempNormal
motorLeftScale, motorRightScale, motorLeftOffset, motorRightOffset
gpsRxBytes, gpsLines
raw
```

---

## 模拟器

没有硬件时用它验证整条链路：

```bash
# 终端 A：起模拟桥
node bin/boatctl.js sim --port 3311 --gps --loop-ms 1000

# 终端 B：对着模拟器跑自检
node bin/boatctl.js selftest --url http://127.0.0.1:3311 --open SIM
```

模拟故障场景，用来验证判定逻辑本身是否可靠：

```bash
node bin/boatctl.js sim --port 3312 --loop-ms 1800 --no-temp --no-imu
node bin/boatctl.js selftest --url http://127.0.0.1:3312 --open SIM
# -> loop / temp / imu 三项 FAIL，退出码 1
```

`--loop-ms` 模拟主循环周期，用来复现"DS18B20 阻塞 750ms"那类问题。

---

## 后续扩展点

已预留、尚未实现：

- `scenario`：把一串操作写成 JSON 脚本顺序执行（连通性 → 传感器 → 电机 → 导航）。
- `sweep`：遍历参数（电机校准系数、PID 增益），每个点采一段并统计，用于自动整定。
- `navtrack`：记录船位轨迹，评估航线贴合度、超调、收敛时间。
- 直接串口模式（绕开 WebUI），用于 WebUI 不在场的极端情况。
