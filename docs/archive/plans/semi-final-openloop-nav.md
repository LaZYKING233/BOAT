# 复赛版本：关磁力计 + 零漂标定 + 池子配置 + 开环导航

## 基础与产物
- **基底**：复制队友版 `后端/new/webui/webui` -> `复赛/webui/`（继承"智渔巡航"侧栏+多视图视觉风格）。
- 在此基础上**移植演示版 demo 功能** + **加新功能**。
- 启动：`复赛/run-webui.bat`（复制队友版 bat，改路径），浏览器开 localhost:3000。
- 固件改动落在主项目 `E:\STM32\BOAT`（Hardware/ + Core/），用户自行用 CubeIDE/Keil 编译烧录（我无法在此编译 STM32）。

## 假设（计划评审时可纠正）
1. 池子仅作**地图显示 + 距离/时间计算参考**，不做硬边界限位（船到边不停）。区域保持**矩形**（现有），仅池子加矩形/圆形。
2. `REG_ALG=0x0B` 写 0 切 6 轴（关磁力计）--寄存器值需用户对照 ATK-IMU901 手册确认（若 0/1 反了改一个数即可）。
3. `REG_GACOFF=0x0D` 触发陀螺零偏校准（需静止）--同样需手册确认。
4. 零漂标定期间电机停、船静止、用户手动把船首对准北。

---

## Part A：固件（E:\STM32\BOAT）

### A1. IMU901.c / .h — 关磁力计 + 零偏标定
- `IMU901_Init()` 增加：`atkpWriteReg(REG_ALG, 0, 1)`（6 轴模式）+ `atkpWriteReg(REG_SAVE, 0, 1)`。
- 新增 `IMU901_CalibrateGyro()`：发 `atkpWriteReg(REG_GACOFF, 1, 1)` 触发模块内部零偏校准（船需静止）。
- 新增 `IMU901_GetYaw()` 不变；新增全局 `yaw_north_ref`（标定时记录的北参考 yaw）。
- 遥测新增字段 `yref`（北参考 yaw ×100）和 `cal`（标定状态 0/1）。

### A2. Lora.c / .h — 新增两条下行命令解析
照现有 target/cmd/motor/mcal 模式，新增：
- `{"t":"calib_gyro"}` -> `Lora_CalibCmd_t` + `Lora_GetPendingCalibCmd()`
- `{"t":"goto_rel","heading":<度,相对北>,"drive_ms":<ms>,"speed":<PWM>}` -> `Lora_GotoRelCmd_t` + `Lora_GetPendingGotoRelCmd()`

### A3. Navigation.c / .h — 开环导航（不依赖 GPS）
新增开环状态机（与现有 GPS 导航并列，**不检查 GPS_IsFixed**）：
- `NAV_OL_TURN`：目标 yaw = `yaw_north_ref + heading`；PID 转向（复用 heading_pid），误差 <3° 持续 0.3s 算转好。
- `NAV_OL_DRIVE`：双电机前向 `speed`，持续 `drive_ms`，期间陀螺保直（PID 修航向）。
- 完成：`Motor_Stop_All()`，回 `NAV_IDLE`，发 `{"t":"ack","kind":"goto_rel","status":"done"}`。
- 新增 `Navigation_GotoRel(heading, drive_ms, speed)` 和 `Navigation_StartCalib()`。
- 标定完成时设 `yaw_north_ref = IMU901_GetYaw()`，置 `cal=1`。

### A4. main.c — 分派新命令
主循环现有分派块后加：
- `calib_gyro` -> `Navigation_StartCalib()`（触发 IMU 校准 + 计时记录北参考）。
- `goto_rel` -> `Navigation_GotoRel(...)`。
- 主循环 50ms 仍调 `Navigation_Update()`，内部按当前 nav.state 分流到 GPS 闭环或开环。

---

## Part B：后端 server.js（复赛/webui/server.js）

### B1. 移植演示版 demo 功能（从 演示/WebUI演示/server.js 搬过来，适配队友版结构）
- `state` 加 `browserLocation / locationBase / locationBaseSource`。
- `seedZones(baseLat, baseLon)` + `reseedZonesAround()` + `establishLocationBase(lat,lon,source)`（MCU GPS 优先）。
- `applyDecodedPayload`（队友版 1610）改：真实 fix>0 用真实 GPS；否则用 `browserLocation` 兜底（fix=1）；都没有 fix=0。浊度强制 `payload.tb=3`，`aiphn=1/aitn=1`。
- 新增 `POST /api/browser-location`（收电脑定位 -> 建基准 + 重排区域 + 建船位 + 广播）。
- `demoSamplingTimer` 模拟采样（适配队友版 `processSamplingData` 旁路：开环模式下跳过 GPS 距离判定）。

### B2. 池子配置（新）
- `state.pool = { mode:'rect'|'circle', center:{lat,lon}, lengthM, widthM, radiusM }`，默认围绕 locationBase。
- `GET /api/pool`、`PUT /api/pool`（实时改）。
- 区域仍用现有 zones（矩形），围绕池子中心排布。

### B3. 零漂标定（新）
- `POST /api/calib/gyro`：通过 `writeSerialMessage({"t":"calib_gyro"})` 下发；服务端起 5s 计时；计时结束时取当前遥测 `iy` 作 `state.headingRef`（北参考）；广播标定状态。前端显示 5s 倒计时 + "请把船首对准北"。

### B4. 开环导航（新，GPS 失效模式）
- `state.openLoop = false`（手动开关）+ `state.metersPerSec`（米/秒标定，可调，默认 0.5）。
- 开环模式下点"巡检区域X"：
  1. 算船位（模拟）-> 区域中心 的方位角 `bearing`（相对北，度）和距离 `dist`（米）。
  2. `drive_ms = dist / metersPerSec * 1000`。
  3. `writeSerialMessage({"t":"goto_rel","heading":bearing,"drive_ms":drive_ms,"speed":60})`。
  4. 服务端模拟：船标按 bearing + 假设速度 在地图上推进 drive_ms。
  5. `drive_ms` 到 -> 标记到达 -> 触发采样（复用现有采样保存）。
  6. 区域内 8 采样点：同样小幅 goto_rel 串联。
- 开环模式下 `processSamplingData` 旁路（不靠 GPS 距离）。

---

## Part C：前端（复赛/webui/public/，继承队友风格）

### C1. 新增面板（在"高级设置"或新增"演示配置"视图里，匹配队友卡片样式）
- **池子配置**：矩形/圆形切换 + 尺寸输入（长×宽 / 半径）+ 实时保存。
- **零漂标定**：按钮"开始测量零漂" + 5s 倒计时 + 提示"请把船首对准北" + 标定状态显示。
- **开环模式开关**：手动切"GPS 失效/开环模式"。
- **米/秒标定输入**：用于距离->时间换算。
- **浏览器定位上报**：`bootstrap()` 加 `reportBrowserLocation()`（从演示版搬）。

### C2. 地图
- 画池子轮廓（矩形 L.rectangle / 圆形 L.circle）+ 区域矩形 + 船标（开环时按模拟位置移动）。
- 开环模式下船标按 `goto_rel` 命令推进（setTimeout 模拟 drive_ms）。

---

## Part D：启动
- `复赛/run-webui.bat`：`cd /d 复赛\webui && npm start`（或 `node server.js`），复制队友版 bat 结构。

---

## 实施顺序
1. **B1 + C1(定位上报) + D**：先移植 demo 功能 + 启动器，保证复赛版能跑、浊度/GPS 兜底和演示版一致。-> 验证：启动看 UI、浊度 3、浏览器定位区域重排。
2. **B2 + C1(池子) + C2(地图池子)**：池子配置 + 地图轮廓。-> 验证：画矩形/圆形池子、实时改。
3. **B3 + C1(零漂)**：零漂标定按钮 + 5s 倒计时（先不下发真命令，mock）。-> 验证：UI 流程。
4. **B4 + C2(开环船位)**：开环导航逻辑 + 船位模拟。-> 验证：点区域->船在地图上按 bearing+时间推进->到达->采样。
5. **A1~A4 固件**：关磁力计 + calib_gyro + goto_rel + 开环状态机（用户编译烧录）。

## 不在本次范围
- MCU 完全挂掉的演示方案（仍 TBD）。
- 固件编译验证（用户侧）。
- 多船协同、避障等扩展。

## 风险
- `REG_ALG`/`REG_GACOFF` 寄存器值需手册确认；值错则关磁力计/标定不生效，改一个数即可。
- 开环距离精度依赖米/秒标定，需现场池子实测。
- 队友版与演示版 sampling 状态机细节有差异，移植 demoSamplingTimer 时需仔细对齐队友版字段。
