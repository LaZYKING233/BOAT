# NanoEdge AI 传感器异常检测数据采集计划

本文档用于指导 `Edge AI CSV Collector` 的实际采集。核心原则：

- **一次实验 = 一个 CSV 文件**。
- 每次开始采集前都重新设置文件名、保存目录和标签。
- CSV 采集阶段保存完整 raw telemetry，后续再按 pH / 浊度 / 温度拆分给 NanoEdge AI Studio。
- 第一版目标是训练 **3 个异常检测模型**：
  1. pH 传感器异常检测
  2. 浊度传感器异常检测
  3. 温度传感器异常检测

---

## 1. 推荐目录结构

建议按下面结构保存 CSV：

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

示例：

```text
E:\STM32\BOAT\edge_ai_data\raw\temperature\normal\temperature_normal_water_idle_001.csv
E:\STM32\BOAT\edge_ai_data\raw\temperature\abnormal\temperature_abnormal_disconnect_001.csv
E:\STM32\BOAT\edge_ai_data\raw\ph\normal\ph_normal_clean_water_idle_001.csv
E:\STM32\BOAT\edge_ai_data\raw\turbidity\abnormal\turbidity_abnormal_blocked_001.csv
```

---

## 2. 每次采集时怎么填标签

采集工具里的字段建议这样填写：

| 字段 | 填写方式 | 示例 |
|---|---|---|
| `target_sensor` | 本次主要采集哪个传感器 | `ph` / `turbidity` / `temperature` |
| `manual_label` | 正常还是异常 | `normal` / `abnormal` |
| `fault_type` | 正常填 `none`，异常填故障来源 | `none` / `ph` / `turbidity` / `temperature` |
| `scene_label` | 具体场景 | `temperature_normal_water_idle` |
| `note` | 人工备注 | `水中静置，DS18B20 正常` |

注意：即使 `target_sensor=temperature`，CSV 里仍然会保存 pH、浊度、GPS、IMU 等完整字段。这是 raw CSV，不代表训练温度模型时会使用全部字段。

---

## 3. 总体采集建议

### 最低可用数据量

如果时间紧，至少采集：

| 模型 | 正常 CSV | 异常 CSV | 每个 CSV 时长 |
|---|---:|---:|---:|
| pH | 3 个 | 2 个 | 2-5 分钟 |
| 浊度 | 3 个 | 3 个 | 2-5 分钟 |
| 温度 | 3 个 | 2 个 | 3-5 分钟 |

### 推荐数据量

如果时间允许，建议采集：

| 模型 | 正常 CSV | 异常 CSV | 每个 CSV 时长 |
|---|---:|---:|---:|
| pH | 5-8 个 | 4-6 个 | 3-5 分钟 |
| 浊度 | 5-8 个 | 5-8 个 | 3-5 分钟 |
| 温度 | 5-8 个 | 3-5 个 | 3-8 分钟 |

### 采集时长建议

- 如果 STM32 约 1 秒一条数据：每个 CSV 至少 2-5 分钟。
- 如果 STM32 约 250ms 一条数据：每个 CSV 1-3 分钟也能有较多行。
- 温度变化慢，温度正常数据建议更长一点。

---

# 4. pH 传感器数据采集

pH 模型要学习的是：**pH 探头输出是否像正常传感器工作状态**，不是判断水质是否适合养鱼。

## 4.1 pH 正常数据

| 优先级 | 场景 | 保存目录 | 文件名示例 | target_sensor | manual_label | fault_type | scene_label | 建议时长 |
|---|---|---|---|---|---|---|---|---|
| 必测 | pH 探头插入清水，静置 | `raw\ph\normal` | `ph_normal_clean_water_idle_001.csv` | `ph` | `normal` | `none` | `ph_normal_clean_water_idle` | 3-5 分钟 |
| 必测 | pH 探头插入池塘水，静置 | `raw\ph\normal` | `ph_normal_pond_water_idle_001.csv` | `ph` | `normal` | `none` | `ph_normal_pond_water_idle` | 3-5 分钟 |
| 建议 | pH 探头插入水中，轻微移动 | `raw\ph\normal` | `ph_normal_water_slight_move_001.csv` | `ph` | `normal` | `none` | `ph_normal_water_slight_move` | 2-3 分钟 |
| 建议 | 小船上电静止，pH 探头正常入水 | `raw\ph\normal` | `ph_normal_boat_idle_001.csv` | `ph` | `normal` | `none` | `ph_normal_boat_idle` | 3-5 分钟 |
| 可选 | 不同水样之间切换后等待稳定 | `raw\ph\normal` | `ph_normal_after_stabilized_001.csv` | `ph` | `normal` | `none` | `ph_normal_after_stabilized` | 3-5 分钟 |

## 4.2 pH 异常数据

| 优先级 | 场景 | 保存目录 | 文件名示例 | target_sensor | manual_label | fault_type | scene_label | 建议时长 |
|---|---|---|---|---|---|---|---|---|
| 必测 | pH 探头悬空，不接触水 | `raw\ph\abnormal` | `ph_abnormal_floating_001.csv` | `ph` | `abnormal` | `ph` | `ph_abnormal_floating` | 1-2 分钟 |
| 必测 | pH 探头半接触水面 / 接触不良 | `raw\ph\abnormal` | `ph_abnormal_bad_contact_001.csv` | `ph` | `abnormal` | `ph` | `ph_abnormal_bad_contact` | 1-2 分钟 |
| 建议 | 快速晃动 pH 探头 | `raw\ph\abnormal` | `ph_abnormal_shake_001.csv` | `ph` | `abnormal` | `ph` | `ph_abnormal_shake` | 1-2 分钟 |
| 建议 | pH 线缆轻微扰动造成跳变 | `raw\ph\abnormal` | `ph_abnormal_wire_disturb_001.csv` | `ph` | `abnormal` | `ph` | `ph_abnormal_wire_disturb` | 1-2 分钟 |
| 可选 | pH 探头刚插入水中未稳定阶段 | `raw\ph\abnormal` | `ph_abnormal_unstable_start_001.csv` | `ph` | `abnormal` | `ph` | `ph_abnormal_unstable_start` | 1-2 分钟 |

---

# 5. 浊度传感器数据采集

浊度模型要学习的是：**浊度传感器输出是否可信**。这一路通常最容易做出明显效果。

## 5.1 浊度正常数据

| 优先级 | 场景 | 保存目录 | 文件名示例 | target_sensor | manual_label | fault_type | scene_label | 建议时长 |
|---|---|---|---|---|---|---|---|---|
| 必测 | 浊度传感器放清水中，静置 | `raw\turbidity\normal` | `turbidity_normal_clean_water_idle_001.csv` | `turbidity` | `normal` | `none` | `turbidity_normal_clean_water_idle` | 3-5 分钟 |
| 必测 | 浊度传感器放池塘水中，静置 | `raw\turbidity\normal` | `turbidity_normal_pond_water_idle_001.csv` | `turbidity` | `normal` | `none` | `turbidity_normal_pond_water_idle` | 3-5 分钟 |
| 必测 | 小船静止漂浮，浊度正常入水 | `raw\turbidity\normal` | `turbidity_normal_boat_idle_001.csv` | `turbidity` | `normal` | `none` | `turbidity_normal_boat_idle` | 3-5 分钟 |
| 建议 | 小船低速移动，浊度正常入水 | `raw\turbidity\normal` | `turbidity_normal_boat_slow_move_001.csv` | `turbidity` | `normal` | `none` | `turbidity_normal_boat_slow_move` | 3-5 分钟 |
| 建议 | 水体轻微扰动但不是故意异常 | `raw\turbidity\normal` | `turbidity_normal_slight_water_move_001.csv` | `turbidity` | `normal` | `none` | `turbidity_normal_slight_water_move` | 2-3 分钟 |

## 5.2 浊度异常数据

| 优先级 | 场景 | 保存目录 | 文件名示例 | target_sensor | manual_label | fault_type | scene_label | 建议时长 |
|---|---|---|---|---|---|---|---|---|
| 必测 | 遮挡浊度传感器光路 | `raw\turbidity\abnormal` | `turbidity_abnormal_blocked_001.csv` | `turbidity` | `abnormal` | `turbidity` | `turbidity_abnormal_blocked` | 1-2 分钟 |
| 必测 | 快速晃动浊度传感器 | `raw\turbidity\abnormal` | `turbidity_abnormal_shake_001.csv` | `turbidity` | `abnormal` | `turbidity` | `turbidity_abnormal_shake` | 1-2 分钟 |
| 必测 | 强光/外部光照干扰 | `raw\turbidity\abnormal` | `turbidity_abnormal_light_interference_001.csv` | `turbidity` | `abnormal` | `turbidity` | `turbidity_abnormal_light_interference` | 1-2 分钟 |
| 建议 | 传感器半入水 / 露出水面 | `raw\turbidity\abnormal` | `turbidity_abnormal_half_in_water_001.csv` | `turbidity` | `abnormal` | `turbidity` | `turbidity_abnormal_half_in_water` | 1-2 分钟 |
| 建议 | 水中大量气泡或剧烈搅动 | `raw\turbidity\abnormal` | `turbidity_abnormal_bubbles_or_stir_001.csv` | `turbidity` | `abnormal` | `turbidity` | `turbidity_abnormal_bubbles_or_stir` | 1-2 分钟 |
| 可选 | 浊度 DOUT 与模拟量表现不一致时 | `raw\turbidity\abnormal` | `turbidity_abnormal_dout_conflict_001.csv` | `turbidity` | `abnormal` | `turbidity` | `turbidity_abnormal_dout_conflict` | 1-2 分钟 |

---

# 6. 温度传感器数据采集

温度模型要学习的是：**DS18B20 输出是否有效、是否可信**。温度变化慢，所以异常检测可以和规则一起用。

## 6.1 温度正常数据

| 优先级 | 场景 | 保存目录 | 文件名示例 | target_sensor | manual_label | fault_type | scene_label | 建议时长 |
|---|---|---|---|---|---|---|---|---|
| 必测 | DS18B20 放清水中，静置 | `raw\temperature\normal` | `temperature_normal_clean_water_idle_001.csv` | `temperature` | `normal` | `none` | `temperature_normal_clean_water_idle` | 5 分钟 |
| 必测 | DS18B20 放池塘水中，静置 | `raw\temperature\normal` | `temperature_normal_pond_water_idle_001.csv` | `temperature` | `normal` | `none` | `temperature_normal_pond_water_idle` | 5 分钟 |
| 必测 | 小船静止漂浮，温度正常入水 | `raw\temperature\normal` | `temperature_normal_boat_idle_001.csv` | `temperature` | `normal` | `none` | `temperature_normal_boat_idle` | 3-5 分钟 |
| 建议 | 小船低速移动，温度正常入水 | `raw\temperature\normal` | `temperature_normal_boat_slow_move_001.csv` | `temperature` | `normal` | `none` | `temperature_normal_boat_slow_move` | 3-5 分钟 |
| 可选 | 从空气放入水中后，等待稳定后的阶段 | `raw\temperature\normal` | `temperature_normal_after_stabilized_001.csv` | `temperature` | `normal` | `none` | `temperature_normal_after_stabilized` | 5 分钟 |

## 6.2 温度异常数据

| 优先级 | 场景 | 保存目录 | 文件名示例 | target_sensor | manual_label | fault_type | scene_label | 建议时长 |
|---|---|---|---|---|---|---|---|---|
| 必测 | DS18B20 断开 / 无效，`temperature_valid=0` | `raw\temperature\abnormal` | `temperature_abnormal_disconnect_001.csv` | `temperature` | `abnormal` | `temperature` | `temperature_abnormal_disconnect` | 1-2 分钟 |
| 必测 | DS18B20 接触不良，时好时坏 | `raw\temperature\abnormal` | `temperature_abnormal_bad_contact_001.csv` | `temperature` | `abnormal` | `temperature` | `temperature_abnormal_bad_contact` | 1-2 分钟 |
| 建议 | 从水中拿到空气中，温度处于快速变化阶段 | `raw\temperature\abnormal` | `temperature_abnormal_transition_001.csv` | `temperature` | `abnormal` | `temperature` | `temperature_abnormal_transition` | 2-3 分钟 |
| 建议 | 人为加热/冷却导致短时间变化过快 | `raw\temperature\abnormal` | `temperature_abnormal_fast_change_001.csv` | `temperature` | `abnormal` | `temperature` | `temperature_abnormal_fast_change` | 2-3 分钟 |
| 可选 | 温度长期完全不变的可疑状态 | `raw\temperature\abnormal` | `temperature_abnormal_stuck_001.csv` | `temperature` | `abnormal` | `temperature` | `temperature_abnormal_stuck` | 3-5 分钟 |

注意：如果断开 DS18B20 会导致固件或总线异常，先短时间测试，不要长时间反复插拔。

---

# 7. 辅助数据：IMU/GPS/串口异常

第一版不建议先训练 IMU/GPS 独立模型，但这些数据可以作为测试和展示材料保存。

| 优先级 | 场景 | 保存目录 | 文件名示例 | target_sensor | manual_label | fault_type | scene_label | 建议时长 |
|---|---|---|---|---|---|---|---|---|
| 可选 | 快速转动船体，IMU 剧烈变化 | `raw\imu\abnormal` | `imu_abnormal_shake_001.csv` | `all` | `abnormal` | `imu` | `imu_abnormal_shake` | 1-2 分钟 |
| 可选 | 室内 GPS 无定位 | `raw\gps\abnormal` | `gps_abnormal_no_fix_indoor_001.csv` | `all` | `abnormal` | `gps` | `gps_abnormal_no_fix_indoor` | 2-3 分钟 |
| 可选 | 串口短暂停止/间歇数据 | `raw\serial\abnormal` | `serial_abnormal_sample_gap_001.csv` | `all` | `abnormal` | `serial` | `serial_abnormal_sample_gap` | 1-2 分钟 |
| 可选 | 小船正常上电静止，所有传感器正常 | `raw\all\normal` | `all_normal_boat_idle_001.csv` | `all` | `normal` | `none` | `all_normal_boat_idle` | 3-5 分钟 |

如果没有建 `imu/gps/serial/all` 目录也没关系，这些是辅助数据，不是第一版必须项。

---

# 8. 最小必测清单

如果你只想先快速得到一批能用的数据，按这个清单测：

## pH

- `ph_normal_clean_water_idle_001.csv`
- `ph_normal_pond_water_idle_001.csv`
- `ph_normal_boat_idle_001.csv`
- `ph_abnormal_floating_001.csv`
- `ph_abnormal_bad_contact_001.csv`

## 浊度

- `turbidity_normal_clean_water_idle_001.csv`
- `turbidity_normal_pond_water_idle_001.csv`
- `turbidity_normal_boat_idle_001.csv`
- `turbidity_abnormal_blocked_001.csv`
- `turbidity_abnormal_shake_001.csv`
- `turbidity_abnormal_light_interference_001.csv`

## 温度

- `temperature_normal_clean_water_idle_001.csv`
- `temperature_normal_pond_water_idle_001.csv`
- `temperature_normal_boat_idle_001.csv`
- `temperature_abnormal_disconnect_001.csv`
- `temperature_abnormal_bad_contact_001.csv`

---

# 9. 采集注意事项

1. **每次实验前先改文件名**，不要覆盖上一组数据。
2. 正常数据不要混入明显异常动作，比如故意晃动、拔线、遮挡。
3. 异常数据要尽量单一：测 pH 异常时，尽量不要同时制造浊度和温度异常。
4. 每个 CSV 的 `scene_label` 要写清楚，后面整理数据时会靠它判断场景。
5. 如果 CSV 行数为 0，先检查串口是否被原 WebUI 或串口助手占用。
6. 如果 `parseErrorCount` 一直增加，说明串口收到的不是完整 JSON 行，需要检查 STM32 输出或串口波特率。
7. 采集前可以先等传感器稳定 30 秒，再点击开始采集正常数据。
8. 异常采集不要持续太久，1-2 分钟通常够用。

---

# 10. 后续训练时的拆分方式

后续导出 NanoEdge 训练集时建议：

## pH 模型使用字段

```text
ph_raw, ph_mv, ph, ph_delta, ph_mv_delta
```

正常数据来源：

```text
raw/ph/normal/*.csv
```

异常测试数据来源：

```text
raw/ph/abnormal/*.csv
```

## 浊度模型使用字段

```text
turbidity_raw, turbidity_mv, turbidity, turbidity_dout, turbidity_valid, turbidity_delta, turbidity_mv_delta
```

正常数据来源：

```text
raw/turbidity/normal/*.csv
```

异常测试数据来源：

```text
raw/turbidity/abnormal/*.csv
```

## 温度模型使用字段

```text
temperature, temperature_valid, temperature_delta
```

正常数据来源：

```text
raw/temperature/normal/*.csv
```

异常测试数据来源：

```text
raw/temperature/abnormal/*.csv
```

温度模型建议额外配合规则：

```text
temperature_valid = 0 持续 N 秒 -> 温度传感器异常
温度短时间跳变过大 -> 可疑
温度长时间完全不变 -> 可疑
```
