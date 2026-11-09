# BOAT WebUI

本机 Node.js + 浏览器 WebUI，用于水产养殖无人船水质监测、区域巡检和 AI 养殖建议。

## 启动

```bash
cd 后端/webui/webui
npm install
npm start
# 访问 http://localhost:3000
```

## 界面说明

- 左上角显示站点名“智航清泓”。
- 左侧是实时船况和区域管理列表。
- 中间是养殖水域地图，显示区域矩形、小船位置、目标点和采样点。
- 右侧是选中区域详情和 AI 区域建议对话框。
- 点击地图区域或左侧区域卡片会同步选中同一个区域。
- 默认界面隐藏调试内容；打开“高级模式”后显示串口发送、电机测试、测试样本、采样历史、通信日志等工程调试工具。

## 区域管理

- 首次启动自动生成 5 个示例区域（A~E 区）。
- 支持新增、编辑、软删除、恢复区域。
- 每区独立配置养殖对象（内置 + 自定义）和阈值。
- 区域几何：中心经纬度 + 南北长度/东西宽度的矩形。
- 区域 ID 由后端自动生成，不可编辑。

## 采样

- 选择区域 → 开始巡检选中区域 → 后端自动启动 8 点巡检。
- 到达判定：中心 1m 优先，5m 兜底，10 分钟超时告警。
- 到点后稳定 30 秒，每 5 秒保存一条样本。
- 采样中离开 5m 暂停告警，回到 5m 后重新稳定。
- 高级模式支持修改采样参数、取消任务、手动采样、测试样本。

## AI 风险分析

- 支持规则兜底、OpenAI-compatible 云端 API、Ollama 本地模型、Anthropic-compatible Messages API。
- 右侧 AI 对话框会结合：区域养殖对象、阈值、最新采样、小船遥测和规则风险基线。
- LLM 不可用时自动使用规则兜底，不影响页面使用。
- 结构化风险结果缓存 5 分钟。

### Anthropic-compatible 安全配置

Anthropic-compatible 模式只从后端环境变量读取密钥，不在浏览器输入，不写入 `data/llm-config.json`。

Git Bash 示例：

```bash
export BOAT_LLM_PROVIDER=anthropic
export ANTHROPIC_AUTH_TOKEN="你的 token"
export ANTHROPIC_BASE_URL="https://token-plan-cn.xiaomimimo.com/anthropic"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="mimo-v2.5-pro"
npm start
```

Windows cmd 示例：

```bat
set BOAT_LLM_PROVIDER=anthropic
set ANTHROPIC_AUTH_TOKEN=你的 token
set ANTHROPIC_BASE_URL=https://token-plan-cn.xiaomimimo.com/anthropic
set ANTHROPIC_DEFAULT_SONNET_MODEL_NAME=mimo-v2.5-pro
npm start
```

可选变量：

- `ANTHROPIC_API_KEY`：如果使用 API key 方式而不是 bearer token。
- `ANTHROPIC_MODEL`：强制指定模型，优先级高于 `ANTHROPIC_DEFAULT_*`。
- `BOAT_ANTHROPIC_SKIP_OAUTH_BETA=1`：如果兼容网关拒绝 `anthropic-beta: oauth-2025-04-20` 头，可设置此变量跳过该头。

安全提醒：不要把 token 粘贴到前端页面、README 或提交记录中。若 token 已经在聊天或截图中暴露，建议到服务提供方重新生成/轮换。

## 串口

- 枚举串口、连接/断开。
- 按 `\r\n` 拆行读取 STM32 JSON。
- 支持发送任意 JSON 指令（高级模式）。
- 支持广播前缀（FF FF）。

## 数据存储

| 文件 | 格式 | 内容 |
|---|---|---|
| `data/zones.json` | JSON | 区域配置、养殖对象、阈值、矩形几何、采样参数 |
| `data/samples.jsonl` | JSONL | 采样历史，每行一条，包含原始 JSON + 归一化字段 |
| `data/llm-config.json` | JSON | LLM 提供商、端点、模型配置；不要存 Anthropic token |

数据目录自动创建，首次启动时 seed 示例区域。

## 协议

### 上行（STM32 → WebUI）

- `boot`：启动消息。
- `data`：周期遥测（pH/浊度/温度/GPS/IMU/导航状态）。

### 下行（WebUI → STM32）

- `target`：目标区域命令。
- `cmd`：stop / start / sensor。
- `motor`：左右电机 PWM。

## 后续扩展

- 端侧 AI 传感器健康评分。
- 趋势图表。
- 数据导出 CSV / JSON。
- GPS 轨迹地图。
