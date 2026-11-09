---
name: boat-sensor-bringup-status
description: Sensor and LoRa bring-up status update for STM32 BOAT project
metadata: 
  node_type: memory
  type: project
  originSessionId: 090257f9-2725-4f5f-a4e1-c02a976f2aa6
---

As of 2026-06-03 update, only LoRa and motors have actually been tested by the user. GPS, pH, turbidity, DS18B20 temperature, and related older code have not been tested and may be outdated.

Historical note from the flying-wire setup: the user previously used a resistor-divider module whose output was approximately the actual signal divided by 20. **This is superseded as of the 2026-06-14 PCB transfer**: pH is now direct to ADC, and turbidity uses a 2/3 divider where ADC voltage is sensor output ×2/3. Do not use the old 1/20 assumption for the current PCB project.

After the user's CubeMX update, `BOAT.ioc` and generated `adc.c` correctly map ADC Rank 1 to `ADC_CHANNEL_1` / PC0 and Rank 2 to `ADC_CHANNEL_2` / PC1, both with long sample time `ADC_SAMPLETIME_391CYCLES_5`. UART4 is generated at 38400 baud for GPS default testing.

The correct LoRa upper-computer program is `E:/STM32/BOAT/2.py`. It is a PyQt5 serial assistant with pyserial, default baud 115200, AT command buttons, send/broadcast helpers, and image chunk support. It sends broadcast frames by prefixing text with bytes/string `\xFF\xFF`.

**Why:** Bring-up should not assume untested sensor code works, and the divider ratio directly affects ADC conversion formulas.

On 2026-06-03, the firmware was changed into a sensor-check mode: no navigation or motor movement, motor outputs are stopped, and LoRa prints pH ADC raw/mV/sensor-estimated mV, turbidity ADC raw/mV/sensor-estimated mV plus DOUT, DS18B20 result/error, and GPS byte/line/fix/satellite/last sentence information. GPS receive tracking was added and the UART4 receive buffer mismatch was fixed. Keil command-line build passed with 0 errors and 0 warnings after the change.

Initial sensor-check output from the user showed: pH raw≈412, adc≈82mV, sensor_est≈1640mV; turbidity raw≈730, adc≈147mV, sensor_est≈2940mV, DOUT=1; DS18B20 temperature≈25.38°C; GPS bytes/lines increasing and last NMEA sentence `$GNRMC,...,V,...`, with fix=0/sat=0 and position 0,0. Interpretation: LoRa, ADC paths, temperature sensor, and GPS UART are alive; GPS has no fix yet because the test was indoors. pH/turbidity are electrically producing signals, but calibration and dynamic response still need testing.

The user now plans to postpone data calibration and GPS outdoor validation, and first complete the algorithm/code framework while at the computer. Future work should build code with calibration placeholders and raw/debug output retained, then tune accuracy later on real hardware.

On 2026-06-04, the user reported receiving a gyro/IMU from a teammate. The firmware already contains an `Hardware/IMU901.c/.h` driver and the Keil project includes it, but current JSON telemetry mode does not initialize or report IMU data. The exact physical module should be confirmed: if it is ATK-IMU901/ATK-MS901M, existing code is relevant; if it is HWT101, the repo only has reference/example materials under `资料/HWT101陀螺仪` and no integrated project driver yet.

After the backend teammate requested JSON, the firmware telemetry output was changed from human-readable sensor-check text to line-delimited JSON over LoRa. Boot now emits a JSON `boot` message. Each data message has fields: `t`, `v`, `seq`, `ms`, `ph` (pH*100), `phr` (pH raw), `phmv` (pH estimated sensor mV), `tb` (temporary NTU), `tbr` (turbidity raw), `tbmv` (turbidity estimated sensor mV), `td` (turbidity digital output), `tc` (temperature*100), `tv` (temperature valid), `fix`, `sat`, `lat`/`lon` (scaled by 1e7, zero if no fix), `gb` (GPS bytes), and `gl` (GPS NMEA lines). Keil build passed with 0 errors and 0 warnings after the JSON telemetry change.

On 2026-06-04, after the user confirmed the module is a 正点原子 IMU and selected USART2 115200, the firmware was updated to initialize `IMU901_Init()`, fix the IMU901 UART interrupt receive buffer start path, and add IMU attitude telemetry fields to each LoRa JSON data message: `iv` (IMU attitude valid), `ir`/`ip`/`iy` (roll/pitch/yaw scaled by degree*100), `ib` (IMU USART2 bytes received), and `ia` (parsed attitude frame count). CubeMX/generated USART2 is now 115200 on PA2/PA3. Keil command-line build passed with 0 errors and 0 warnings after the IMU telemetry change.

**How to apply:** Test one module at a time. First use ADC raw voltage reporting over LoRa/serial, then calibrate pH/turbidity formulas using the current PCB scaling (pH direct, turbidity ×3/2). Related: [[boat-code-state-2026-06-03]], [[boat-current-hardware]], [[boat-workflow-preferences]], [[boat-pcb-bringup-2026-06-14]].
