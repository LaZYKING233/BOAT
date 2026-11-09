# 智航清泓 · 产品流程与实现计划

> 统一产品叙事、数据模型、接口协议和里程碑。原则：先把概念和接口写清楚，再按端到端小闭环实现。

---

## 1. 产品定位

面向水产养殖户的本机 Web 无人船水质监测系统。

- 用户关心：哪个区域水质如何、是否适合当前养殖对象、是否有风险、是否需要派船采样。
- 演示部署：本机电脑优先，不依赖云服务器/小程序/手机。

---

## 2. 核心领域模型

### 2.1 养殖区域（Zone）

保存在 `data/zones.json`，几何模型为中心点 + 南北长度/东西宽度的轴对齐矩形。

```json
{
  "id": "zone_A",
  "name": "A区 草鱼塘",
  "speciesProfile": {
    "type": "builtin",
    "key": "grass_carp",
    "label": "草鱼",
    "thresholds": { "phMin": 6.5, "phMax": 8.5, "tempMin": 18, "tempMax": 30, "turbidityMax": 30 }
  },
  "geometry": {
    "type": "axis_aligned_rectangle",
    "center": { "latitude": 34.5001, "longitude": 104.0001 },
    "lengthM": 20,
    "widthM": 10
  },
  "deletedAt": null
}
```

- `id` 后端自动生成，用户不可编辑。
- `center` 使用十进制度数，发送 target 时自动转 `*1e7` 整数。
- 区域支持新增、编辑、软删除、恢复。

### 2.2 养殖对象

每个区域独立配置。内置品种：草鱼、鲫鱼、鲤鱼、鲈鱼、虾、蟹。自定义品种必须手动输入完整阈值。

### 2.3 采样数据（Sample）

保存在 `data/samples.jsonl`，每行一条。

```json
{
  "id": "sample_...",
  "zoneId": "zone_A",
  "source": "serial",
  "attributionMethod": "active_target",
  "gpsValidation": { "validated": true, "arrivalMode": "strict_1m" },
  "water": { "ph": 7.32, "tempC": 24.5, "turbidity": 18, "phRaw": 1234, "phMv": 2010, "turbidityRaw": 2345, "turbidityMv": 1200 },
  "gps": { "fix": 1, "latitude": 34.5, "longitude": 104.0 },
  "imu": { "valid": true, "roll": 1.2, "pitch": 0.3, "yaw": 90.0 },
  "raw": { "...": "完整 STM32 data JSON" }
}
```

来源类型：`serial`（正式）、`manual`（手动强制）、`advanced_test`（测试）。

---

## 3. 通信协议

### 3.1 上行：STM32 → WebUI

每行 JSON 以 `\r\n` 结尾，周期约 250ms。

关键字段：`ph`(×100)、`phr`(raw)、`phmv`(mV×20)、`tb`(NTU)、`tbr`(raw)、`tbmv`(mV×20)、`td`(0/1)、`tc`(℃×100)、`tv`(0/1)、`fix`(0/1)、`lat/lon`(×1e7)、`iv`(0/1)、`ir/ip/iy`(度×100)、`ns`(导航状态)、`nd`(距离×100)、`nt`(航向误差×100)。

### 3.2 下行：WebUI → STM32

```json
{"t":"target","zone":"zone_A","lat":345001000,"lon":1040001000,"r":5}
{"t":"cmd","cmd":"stop"}
{"t":"cmd","cmd":"sensor"}
{"t":"motor","l":50,"r":50}
```

STM32 收到后回 ack JSON。

---

## 4. 采样流程

1. 用户在 WebUI 选择区域，点击"发送目标"。
2. Node.js 后端通过串口发送 target JSON，成功后启动采样任务。
3. 自动按区域矩形生成 8 个采样点（4 角 + 4 边中点）。
4. 依次前往每个点：到达中心 1m 优先，进入 5m 后 1 分钟仍未到 1m 则接受 5m；10 分钟未进 5m 则暂停告警。
5. 到点后稳定 30 秒，然后每 5 秒保存一条样本。
6. 走完所有点后任务结束，进入待机。
7. 采样中离开 5m 则暂停并告警，回到 5m 后重新稳定 30 秒再继续。
8. Node 重启不恢复未完成任务。

---

## 5. 风险分析

- 后端支持云端 API（DeepSeek/通义千问）和 Ollama 本地模型。
- LLM 不可用时自动用规则兜底（按阈值判断 normal/warning/danger）。
- 每个区域独立分析，不同养殖对象可能产生不同风险结论。
- 结果缓存 5 分钟。

---

## 6. WebUI 布局

- **左侧**：区域卡片网格（pH/水温/浊度/风险/采样状态）
- **右上**：小地图，矩形色块显示区域分布
- **右下**：选中区域详情、风险分析、操作按钮
- **设置齿轮**：串口、指令、采样参数、LLM、区域管理、历史管理、通信日志
- **高级模式**：控制高级设置项的显示

---

## 7. 里程碑状态（2026-06-07）

| 里程碑 | 状态 |
|---|---|
| M0：计划与接口冻结 | ✅ |
| M1：WebUI 模拟闭环 | ✅ |
| M2：本地存储 + 采样状态机 | ✅ |
| M3：串口真数据接入 | ✅ 代码就绪 |
| M4：STM32 下行解析 | ✅ |
| M5：导航/区域保持 | ✅ |
| M6：LLM 风险分析 | ✅ |
| M7：完整演示脚本 | ⏳ 待硬件测试 |

---

## 8. 不做的内容

- 手机/小程序/公网服务器
- 多船管理/用户账号
- 复杂 GIS 区域绘制/拖拽/吸附
- SQLite/云数据库
- 数据导出/时间范围删除
- AI 阈值推荐
- 趋势图表
- Node 重启后自动恢复采样任务

---

## 9. 实现原则

1. 每次只做一个端到端小闭环。
2. 硬件驱动放 `Hardware/`，纯算法放 `System/`。
3. WebUI 保持本机演示优先。
4. 协议字段变更同步更新 README 和本文档。
5. 实测结果优先于假设。
