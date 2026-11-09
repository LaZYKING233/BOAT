# 智航清泓 · 无人船水产养殖水质监测系统

> 基于 STM32U5 + LoRa + GPS/IMU/水质传感器的无人船，配合本机 Node.js WebUI，面向水产养殖场景。
> 当前根目录：`E:/STM32/BOAT`

---

## 项目概述

**智航清泓** 是一个面向水产养殖户的无人船水质监测产品。无人船搭载 pH、浊度、温度传感器和 GPS/IMU，通过 LoRa 将数据传回本机电脑上的 WebUI，养殖户可以在网页上查看各养殖区域的水质状态、风险分析，并指挥小船前往指定区域采样。

**演示部署**：本机电脑优先。LoRa 接收端通过 USB 串口接到演示电脑，本机 Node.js 服务读取串口，浏览器打开 `http://localhost:3000`。

**比赛方向**：全国大学生嵌入式芯片与系统设计竞赛 · 意法半导体赛道 · 选题六 IoT。

---

## 当前进度（2026-06-08）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1：区域卡片 + 基础 UI | ✅ | 默认界面显示固定养殖区域 |
| M2：本地存储 + 采样状态机 | ✅ | `data/zones.json` + `data/samples.jsonl` 持久化 |
| 地图默认化 + 矩形数据标注 | ✅ | 地图移到默认界面，矩形上直接显示数据 |
| 多采样点巡检 | ✅ | 8 个点自动按矩形生成，依次巡检 |
| M3：串口真数据接入 | ✅ | 代码就绪，待硬件验证 |
| M4：STM32 下行解析 | ✅ | target/cmd/motor/mcal 四种命令已解析 |
| M5：导航/区域保持 | ✅ | PID 航向控制 + 区域保持 + 漂移修正 |
| M6：LLM 风险分析 | ✅ | 云端 API + Ollama + 规则兜底 |
| WebUI 三栏重写 | ✅ | 遥测面板 + 区域卡片 + 测试/控制面板 |
| 电机校准系统 | ✅ | 固件 per-motor scale/offset + WebUI 可调 |

**下一步**：连接真实硬件测试（STM32 + LoRa + GPS + IMU）。

---

## 系统架构

```
STM32U5 传感器/电机控制板
  ↓ LoRa (USART3, 115200)
USB 串口接收端
  ↓
本机 Node.js 服务 (server.js)
  ↓ WebSocket
本机浏览器 WebUI (http://localhost:3000)
```

### WebUI 三栏布局

- **左侧（深色遥测面板）**：实时传感器数据 — 连接状态、pH/浊度/温度（含 raw/mV）、GPS（fix/卫星/经纬度/字节）、IMU（Roll/Pitch/Yaw/字节）、导航状态/距离/航向误差、序列号/uptime、电机校准值、可折叠原始 JSON
- **中间**：Leaflet 地图（始终显示，矩形色块标注区域）+ 区域卡片网格（pH/水温/浊度/风险状态）
- **右侧**：快捷指令（停船/启动/传感器）、电机测试（左右滑块+预设）、电机校准（缩放滑块+偏移输入）、导航监视器（大字状态+距离+航向）、区域详情（风险分析+操作按钮）
- **设置齿轮 ⚙**：串口连接、手动指令发送、采样参数、LLM 配置、区域管理、采样历史、通信日志
- **高级模式**：开关在右上角

---

## 硬件连接

### TB6612 + 双电机

| 信号 | 引脚 | 功能 |
|---|---|---|
| PWMA | PE9 | TIM1_CH1 PWM |
| AIN1/AIN2 | PC8/PC9 | 电机 A 方向 |
| STBY | PD4 | TB6612 使能 |
| BIN1/BIN2 | PC10/PC11 | 电机 B 方向 |
| PWMB | PE11 | TIM1_CH2 PWM |

### 其他模块

| 模块 | 引脚 | 波特率/说明 |
|---|---|---|
| LoRa | PB10(TX)/PB11(RX) | USART3, 115200 |
| GPS | PA0(TX)/PA1(RX) | UART4, 38400 |
| IMU901 | PA2(TX)/PA3(RX) | USART2, 115200 |
| pH | PC0 | ADC1_IN1，PCB 新版直连 ADC（不分压） |
| 浊度 | PC1(模拟)/PB0(数字) | ADC1_IN2，2/3 分压（ADC=传感器×2/3） |
| DS18B20 | PB1 | GPIO, 4.7k 上拉 |

---

## 通信协议

### 上行：STM32 → WebUI

每行 JSON 以 `\r\n` 结尾，周期约 250ms。

**boot 消息**（启动时一次）：
```json
{"t":"boot","v":1,"ms":123,"msg":"boat telemetry start","phdiv":100,"tbdiv":150}
```

**data 消息**（周期发送）：
```json
{"t":"data","v":1,"seq":0,"ms":1234,
 "ph":717,"phr":412,"phmv":1640,
 "tb":2860,"tbr":730,"tbmv":2940,"td":1,"tbv":1,
 "tc":2538,"tv":1,
 "fix":0,"sat":0,"lat":0,"lon":0,
 "iv":1,"ir":12,"ip":-34,"iy":9012,"ib":2048,"ia":128,
 "gb":76438,"gl":1228,
 "ns":1,"nd":350,"nt":-123,
 "mls":100,"mrs":85,"mlo":0,"mro":10}
```

| 字段 | 含义 | 缩放 |
|---|---|---|
| `ph` | pH 值 | ×100 |
| `phr` | pH ADC 原始值 | raw |
| `phmv` | pH 传感器估计电压 mV | PCB 新版：ADC mV（不分压） |
| `tb` | 浊度 NTU | 直接值 |
| `tbr` | 浊度 ADC 原始值 | raw |
| `tbmv` | 浊度传感器估计电压 mV | PCB 新版：ADC mV × 3/2 |
| `td` | 浊度数字输出 | 0/1 |
| `tbv` | 浊度状态 | 1 有效 / 0 ADC 读取无效 |
| `tc` | 温度 | ℃×100 |
| `tv` | 温度有效 | 1 有效 |
| `fix` | GPS 定位 | 0 未定位 |
| `lat/lon` | 经纬度 | ×10000000 |
| `iv` | IMU 有效 | 1 有效 |
| `ir/ip/iy` | Roll/Pitch/Yaw | 度×100 |
| `ns` | 导航状态 | 0 空闲/1 导航/2 保持/3 GPS丢失 |
| `nd` | 到目标距离 | 米×100 |
| `nt` | 航向误差 | 度×100 |
| `mls` | 左电机校准缩放 | ×100 (100=1.00) |
| `mrs` | 右电机校准缩放 | ×100 |
| `mlo` | 左电机校准偏移 | 直接值 |
| `mro` | 右电机校准偏移 | 直接值 |

### 下行：WebUI → STM32

```json
{"t":"target","zone":"zone_A","lat":345001000,"lon":1040001000,"r":5}
{"t":"cmd","cmd":"stop"}
{"t":"cmd","cmd":"start"}
{"t":"cmd","cmd":"sensor"}
{"t":"motor","l":50,"r":50}
{"t":"mcal","ls":1.0,"rs":0.85,"lo":0,"ro":10}
```

| 命令 | 固件行为 |
|---|---|
| `target` | 设置导航目标，启动导航 |
| `cmd stop` | 停止导航 + 电机 |
| `cmd start` | 回 ack（暂无实际动作） |
| `cmd sensor` | 立即发送一次遥测数据 |
| `motor` | 直接设置左右电机 PWM（-100~100） |
| `mcal` | 设置电机校准系数（缩放 0.1~2.0，偏移 -200~200） |

WebUI 内置按钮/目标发送直接下发 JSON（与手动发送一致）；手动发送可通过广播开关选择是否加 `\xFF\xFF` 前缀。STM32 收到后回 ack JSON。

---

## 电机校准系统

两个推进电机物理特性可能不同，导致相同 PWM 下转速不一致。校准系统允许为每个电机设置独立的缩放系数和偏移量：

- **缩放（scale）**：PWM 输出乘以此系数。左电机慢了就把右电机的 scale 调低（如 0.80）
- **偏移（offset）**：PWM 输出加此值。补偿电机死区（低 PWM 不转的问题）
- 校准只影响推进电机（SPEED_LEFT/RIGHT），不影响转向电机

WebUI 右侧"电机校准"面板可实时调整，调整后点"应用校准"发送 `mcal` 命令。遥测面板实时显示当前固件中的校准值。

---

## 固件模块

| 文件 | 功能 |
|---|---|
| `Core/Src/main.c` | 主循环：初始化、遥测发送、下行命令处理（target/cmd/motor/mcal）、导航更新 |
| `Core/Src/usart.c` | UART 初始化与中断回调 |
| `Hardware/Lora.c` | LoRa 发送/接收，JSON 解析 target/cmd/motor/mcal |
| `Hardware/Navigation.c` | PID 航向控制、距离/航向计算、导航状态机 |
| `Hardware/Motor.c` | TB6612 电机驱动 + per-motor 校准 |
| `Hardware/GPS.c` | NMEA 解析 |
| `Hardware/IMU901.c` | 正点原子 IMU901 姿态解析 |
| `Hardware/PH.c` | pH ADC 读取 |
| `Hardware/Turbidity.c` | 浊度 ADC 读取 |
| `Hardware/DS18B20.c` | 温度读取 |

---

## WebUI 后端

`后端/webui/webui/server.js` 是单文件 Node.js 服务：

- Express + WebSocket + SerialPort
- 本地存储：`data/zones.json`（区域配置）、`data/samples.jsonl`（采样历史）
- 采样状态机：target 后自动 8 点巡检，每点 30s 稳定 + 5s 间隔采样
- LLM 风险分析：支持云端 API（DeepSeek/通义千问）和 Ollama 本地模型
- 规则兜底：LLM 不可用时按阈值判断

启动：
```bash
cd 后端/webui/webui
npm install
npm start
# 访问 http://localhost:3000
```

---

## 已知问题

1. **pH/浊度未校准**：当前公式为临时值，需用标准液校准。
2. **PCB 新版分压已变化**：pH 直连 ADC；浊度为 2/3 分压（ADC=传感器×2/3）。不要再按旧 1/20 分压排查。
3. **GPS 室内无 fix**：预期现象，需室外测试。
4. **LoRa 拆包**：串口读取可能分段，后端已按 `\r\n` 拆行处理。
5. **IMU 待验证**：烧录后观察 `ib/ia/iv` 判断是否正常。
6. **电机转速差异**：已加入校准系统，需实测调整 scale/offset。

---

## 重要文件索引

| 文件 | 作用 |
|---|---|
| `README.md` | 本文件 |
| `HANDOFF.md` | 队友交接文档（测试流程、检查清单、已知问题） |
| `docs/PRODUCT_PLAN.md` | 产品流程、数据模型、协议和里程碑 |
| `docs/memory/` | Claude 项目记忆（12 个文件，含硬件/代码/产品/比赛历史） |
| `BOAT.ioc` | CubeMX 配置 |
| `Core/Src/main.c` | STM32 主逻辑 |
| `Hardware/` | 硬件驱动模块 |
| `后端/webui/webui/server.js` | Node.js 后端 |
| `后端/webui/webui/public/` | WebUI 前端（index.html + app.js + styles.css） |
| `后端/webui/webui/data/` | 本地数据（区域+样本） |
| `2.py` | LoRa 上位机串口助手 |
| `MDK-ARM/BOAT.uvprojx` | Keil 工程 |

---

## 给后续开发的提醒

1. 不要把 `ph`/`tb` 当最终准确数据，后端务必保存 raw/mV 字段。
2. 改引脚请在 CubeMX 里改，不要手改生成代码。
3. 硬件驱动放 `Hardware/`，纯算法放 `System/`。
4. 采样数据按用户选择的目标区域归属，GPS 用于显示和校验。
5. 每个区域独立配置养殖对象和阈值，不要全场统一。
6. 默认 WebUI 面向养殖户，高级模式才显示调试信息。
7. 电机校准值通过 WebUI 调整，不需要改固件代码。
