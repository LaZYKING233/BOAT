# NanoEdge AI 接入说明

本项目当前接入了两个 NanoEdge AI Studio 训练出的异常检测模型：

| 模型 | 原始包 | 固件目录 | 输入维度 |
|---|---|---|---:|
| pH 传感器健康检测 | `AI/[h.zip` | `AI/ph/` | 5 |
| 温度传感器健康检测 | `AI/tem.zip` | `AI/temperature/` | 3 |

## 1. 为什么不能直接使用 zip 里的 libneai.a

NanoEdge AI Studio 为每个模型生成的默认 API 名称都一样：

```c
neai_anomalydetection_init
neai_anomalydetection_learn
neai_anomalydetection_detect
neai_get_id
neai_get_input_signal_size
neai_get_axis_number
```

如果 pH 和温度两个 `libneai.a` 同时加入工程，会出现重复符号链接错误。

因此本项目已经把两个库的符号分别加前缀：

pH：

```c
ph_neai_anomalydetection_init
ph_neai_anomalydetection_detect
```

温度：

```c
temperature_neai_anomalydetection_init
temperature_neai_anomalydetection_detect
```

对应文件：

```text
AI/ph/libneai_ph.a
AI/ph/NanoEdgeAI_ph.h
AI/temperature/libneai_temperature.a
AI/temperature/NanoEdgeAI_temperature.h
```

不要在 CubeIDE 里再添加这些旧文件：

```text
AI/libneai.a
AI/NanoEdgeAI.h
AI/ph/libneai_original.a
AI/temperature/libneai_original.a
```

这些只保留作备份/溯源。

## 2. 固件包装层

固件通过下面两个文件调用 NanoEdge：

```text
Hardware/EdgeAI.h
Hardware/EdgeAI.c
```

对 `main.c` 暴露的接口：

```c
void EdgeAI_Init(void);
void EdgeAI_UpdatePh(int32_t ph_x100, uint32_t ph_raw, uint32_t ph_mv);
void EdgeAI_UpdateTemperature(int32_t temp_x100, uint8_t temp_valid);
EdgeAI_Status_t EdgeAI_GetStatus(void);
```

## 3. 输入字段顺序

pH 模型输入顺序必须保持：

```text
ph_raw, ph_mv, ph, ph_delta, ph_mv_delta
```

温度模型输入顺序必须保持：

```text
temperature, temperature_valid, temperature_delta
```

## 4. telemetry 新增字段

LoRa JSON 里新增：

```json
"aiph":91,
"aiphn":1,
"ait":87,
"aitn":1
```

含义：

| 字段 | 含义 |
|---|---|
| `aiph` | pH 模型 similarity，0-100 |
| `aiphn` | pH 是否正常，1 正常 / 0 异常 |
| `ait` | 温度模型 similarity，0-100 |
| `aitn` | 温度是否正常，1 正常 / 0 异常 |

当前阈值在 `Hardware/EdgeAI.h`：

```c
#define EDGE_AI_PH_NORMAL_THRESHOLD           80U
#define EDGE_AI_TEMPERATURE_NORMAL_THRESHOLD 80U
```

如果上板后发现过于敏感或不敏感，优先调整这两个阈值。

## 5. STM32CubeIDE 需要确认的配置

我已经尝试在 `.cproject` 中加入：

Include paths：

```text
../Hardware
../AI/ph
../AI/temperature
```

Source path：

```text
Hardware
```

Linker additional input：

```text
../AI/ph/libneai_ph.a
../AI/temperature/libneai_temperature.a
```

如果 CubeIDE 导入后仍然编译失败，请在 CubeIDE 里手动检查：

1. Project Properties → C/C++ Build → Settings → MCU GCC Compiler → Include paths
2. Project Properties → C/C++ Build → Settings → MCU GCC Linker → Libraries 或 Miscellaneous
3. 确认 `Hardware/EdgeAI.c` 被纳入编译
4. 确认只链接 `libneai_ph.a` 和 `libneai_temperature.a`，不要链接旧的 `AI/libneai.a`

## 6. ABI 警告说明

如果 CubeIDE 链接时出现类似警告：

```text
uses 32-bit enums yet the output is to use variable-size enums
```

这是 NanoEdge 静态库和工程默认 enum ABI 标记不一致导致的链接警告。当前包装头文件已经避免在应用层直接使用 NanoEdge 的 C enum，但如果 CubeIDE 仍然提示这个警告，可以在：

```text
Project Properties -> C/C++ Build -> Settings -> MCU GCC Compiler -> Miscellaneous -> Other flags
```

加入：

```text
-fno-short-enums
```

这样工程会和 NanoEdge 库的 32-bit enum ABI 保持一致。

## 7. 常见错误

### multiple definition of `neai_anomalydetection_detect`

说明你把未改名前缀的原始 `libneai.a` 加进去了。请移除旧库，只保留：

```text
AI/ph/libneai_ph.a
AI/temperature/libneai_temperature.a
```

### undefined reference to `ph_neai_anomalydetection_detect`

说明 pH 库没有被正确链接。检查 linker input 是否包含：

```text
../AI/ph/libneai_ph.a
```

### undefined reference to `temperature_neai_anomalydetection_detect`

说明温度库没有被正确链接。检查 linker input 是否包含：

```text
../AI/temperature/libneai_temperature.a
```

### `EdgeAI.h` 找不到

说明 `../Hardware` 没有加入 include path，或者 `Hardware` 没有被 CubeIDE 正确识别。
