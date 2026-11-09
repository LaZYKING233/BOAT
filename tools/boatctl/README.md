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
| `goto <lat> <lon> [--arrive 2] [--hold 6]` | **纯导航到点**，不启动采样任务 |
| `navrun --to lat,lon --gains ...` | **设定目标 → 实跑 → 落盘 → 出调参报告** |
| `pidreport x.jsonl [--json]` | 复盘某次实跑，给出参数调整方向 |
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

## PID 整定流程

真实水面的干扰是风和流，PID 的任务就是让船头持续对准目标。所以整定不是
"调到看起来顺"，而是**用实跑数据判断是哪一环在拖后腿**。

标准循环：

```
改 Navigation_Init() 的参数  ->  编译烧录  ->  navrun 跑一段  ->  看报告  ->  再改
```

```bash
node bin/boatctl.js navrun --open COM7 \
  --to 34.50021,104.00024 \
  --gains 2.0,0.35,0.25 \
  --xgains 2.3,0.30,0.12 \
  --label 实验1-kp2.0 \
  --note "东北向 18m，微风"
```

每次运行落两个文件：

```
runs/实验1-kp2.0-<时间>.jsonl       逐帧遥测
runs/实验1-kp2.0-<时间>.meta.json   增益、目标、停止原因、备注
```

**把 `--gains` 写进去是关键**：下次复盘时能确定"这份数据是哪组参数跑出来的"，
不会出现参数和数据对不上、白跑一轮的情况。

### 报告里的指标

| 指标 | 含义 | 目标 |
|---|---|---|
| `±10° 内占比` | 航向误差维持在 ±10° 以内的时间比例 | ≥ 80% |
| `平均 / P95 误差` | 航向跟踪的整体水平 | 平均 < 8°，P95 < 15° |
| `零穿次数 / 周期` | 误差在正负之间来回切换的频率 | 越少越好，周期 > 10s |
| `饱和占比` | `turn_output` 顶到限幅的时间比例 | < 10% |
| `稳态有符号均值` | 末段误差的**方向**——持续同号说明有恒定外力 | < 8° |
| `横向偏差 RMS` | 船偏离航线的程度 | < 3 m |
| `收敛时刻` | 第几秒起误差稳定在 ±10° 内 5 秒 | 越早越好 |

### 决策表

| 现象 | 报告里的信号 | 改什么 |
|---|---|---|
| 船头左右反复摆 | 零穿多、周期 < 10s、摆幅 > 6° | 降 `heading kp`（×0.7） |
| 大周期缓慢漂摆 | 零穿少但周期 > 10s | 升 `kd`（×1.5），仍漂再降 `ki` |
| 一直偏向一侧 | 稳态有符号均值 > 8°，且未饱和 | 升 `ki`（×1.6）——这是风和流 |
| 电机长期打满 | 饱和占比 > 30% | 降 `kp`，或查电机校准/桨效是否左右不对称 |
| 航向跟住了但不贴航线 | 横向 RMS > 3m | 升 `crosstrack kp`（×1.4） |

报告会按这个优先级给结论：**先振荡、再饱和、最后才谈跟踪精度**。
振荡没解决之前调 `ki` 是没有意义的。

### 离线复盘

```bash
node bin/boatctl.js pidreport runs/实验1-kp2.0-xxx.jsonl
node bin/boatctl.js pidreport runs/实验1-kp2.0-xxx.jsonl --json > report.json
```

会自动读取同名 `.meta.json` 里的增益信息。加 `--no-plot` 可关掉 ASCII 曲线。

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
await c.goto(34.5002, 104.0002, { arrive: 2, hold: 6 }); // 纯导航，不启采样任务
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

已实现：`goto` / `navrun` / `pidreport`（见上）。

尚未实现：

- `sweep`：自动遍历增益（kp 依次取 1.2/1.6/2.0…），每点跑一次 navrun 并汇总，
  省去手动改编译烧录的循环。需要参数能在运行时下发才有意义（当前 PID 增益是编译期常量）。
- `scenario`：把一串操作写成 JSON 脚本顺序执行（连通性 → 传感器 → 电机 → 导航）。
- 直接串口模式（绕开 WebUI），用于 WebUI 不在场的极端情况。
