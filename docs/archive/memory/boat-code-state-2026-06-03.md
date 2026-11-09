---
name: boat-code-state-2026-06-03
description: Observed STM32 BOAT firmware state and likely bring-up issues on 2026-06-03
metadata: 
  node_type: memory
  type: project
  originSessionId: 090257f9-2725-4f5f-a4e1-c02a976f2aa6
---

Repository state observed on 2026-06-03:

- Project root `E:/STM32/BOAT` is not a git repository.
- STM32Cube project `BOAT.ioc` targets STM32U5A5ZJTxQ / STM32U5A5ZJT6Q, MDK-ARM toolchain, Cube FW_U5 V1.8.0.
- Main firmware files are under `Core/` and custom drivers under `Hardware/`.
- `Hardware/` contains Motor, Lora, GPS, Navigation, IMU901, PH, Turbidity, and DS18B20 modules. Keil project includes these files.
- Last Keil build log `MDK-ARM/BOAT/BOAT.build_log.htm` shows 0 errors and 0 warnings, built with Keil uVision V5.36 / ARMClang V6.16 around 2026-05-08/09.
- Current `main.c` initializes Motor, Lora, DS18B20, IMU901, PH, Turbidity, GPS, and Navigation, sets a hard-coded target coordinate, starts navigation, and prints navigation debug info over LoRa every 200 ms.
- Motor wiring in code matches the currently connected two TB6612 channels for propulsion: PE9/TIM1_CH1 + PC8/PC9 and PE11/TIM1_CH2 + PC10/PC11. PD4 is configured high in GPIO init and can serve as TB6612 STBY. Code also contains unused 4-motor support for PE13/PE14 and PC12/PD2/PB13/PB14.
- LoRa code sends strings on USART3. Cube config maps USART3 to PB10 TX and PB11 RX, matching the reported LoRa wiring.
- Important likely issue: UART interrupt receive buffers are inconsistent. `GPS_Init()` starts UART4 reception into a local static byte, but `HAL_UART_RxCpltCallback()` processes a different file-scope `gps_rx_byte`. `IMU901_Init()` starts USART2 reception into `rxPacket` instead of the file-scope `imu901_rx_byte` that the callback parses. GPS/IMU reception likely will not parse correctly until this is fixed.
- Since only motors and LoRa are physically connected, the current main loop is over-scoped for bring-up: it initializes and depends on unconnected GPS/IMU/sensors, so navigation will stop at `NAV_NO_GPS` and motor movement will not happen unless GPS fix is simulated/connected or navigation is bypassed.
- ADC config in `BOAT.ioc` has ADC1 channels PC0/PC1, but both regular ranks appear to list `ADC_CHANNEL_1`; generated `adc.c` config also sets channel 1 then changes only rank for the second channel, so PH/Turbidity channel separation should be rechecked before sensor use.

**Why:** This captures where the firmware stood before any June 2026 edits, including the gap between current hardware and planned full system.

**How to apply:** Next coding session should avoid broad refactors. First create/flash a minimal test loop for TB6612 + LoRa only, verify PWM/direction/STBY and serial telemetry, then separately restore sensors/navigation. Related: [[boat-current-hardware]], [[boat-plan-and-competition-context]].
