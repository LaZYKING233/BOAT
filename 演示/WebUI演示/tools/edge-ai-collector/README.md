# Edge AI CSV Collector

独立的串口转 CSV 采集工具，用于 NanoEdge AI Studio 数据采集。

## 运行

在 `后端/webui/webui` 目录运行：

```bash
npm run collector
```

或者直接运行：

```bash
node tools/edge-ai-collector/collector-server.js
```

然后打开：

```text
http://localhost:3100
```

如需换端口：

```bash
COLLECTOR_PORT=3101 npm run collector
```

## 使用流程

1. 关闭原 WebUI 或其他串口助手，避免串口被占用。
2. 选择串口和波特率，默认 `115200`。
3. 输入保存目录和文件名。
4. 设置本次实验标签：
   - `target_sensor`: `ph` / `turbidity` / `temperature` / `all`
   - `manual_label`: `normal` / `abnormal`
   - `fault_type`: 正常填 `none`，异常可填 `ph` / `turbidity` / `temperature` 等
   - `scene_label`: 例如 `temperature_normal_water_idle`
   - `note`: 人工备注
5. 点击“开始采集”。
6. 实验结束后点击“停止采集”。
7. 本次实验会生成一个独立 CSV 文件。

下一次实验请重新输入新的文件名，再点击“开始采集”。

## CSV 说明

- 一个 CSV 文件 = 一次实验 / 一次连续采集。
- 一行 CSV = STM32 发来的一条 `t=data` telemetry。
- CSV 内保存完整 raw telemetry 字段，同时带上本次实验的元信息。
- 后续训练 NanoEdge 模型时，再从多个 raw CSV 中按 pH / 浊度 / 温度分别导出训练集。

## 输出字段

```text
session_id,timestamp_iso,timestamp_ms,target_sensor,manual_label,fault_type,scene_label,note,seq,uptime_ms,ph,ph_raw,ph_mv,turbidity,turbidity_raw,turbidity_mv,turbidity_dout,turbidity_valid,temperature,temperature_valid,gps_fix,gps_sat,gps_lat,gps_lon,imu_valid,roll,pitch,yaw,nav_state,nav_distance_m,nav_heading_error_deg,ph_delta,ph_mv_delta,turbidity_delta,turbidity_mv_delta,temperature_delta,yaw_delta,sample_interval_ms,raw_json
```

## 建议目录

```text
edge_ai_data/
  raw/
    ph/
      normal/
      abnormal/
    turbidity/
      normal/
      abnormal/
    temperature/
      normal/
      abnormal/
```

示例文件名：

```text
temperature_normal_001.csv
temperature_abnormal_disconnect_001.csv
ph_normal_clean_water_001.csv
ph_abnormal_floating_001.csv
turbidity_abnormal_blocked_001.csv
```
