---
name: boat-code-state-2026-06-08
description: Firmware and WebUI state as of 2026-06-08, including motor calibration and three-panel WebUI
metadata:
  node_type: memory
  type: project
  originSessionId: 66d13884-4af6-4c1d-9cdd-10c05ef332f1
---

As of 2026-06-08, the project has a complete firmware + WebUI stack ready for hardware testing.

**Firmware state (Keil MDK-ARM, STM32U5A5ZJT6Q):**
- All M1~M6 code complete, 0 errors/0 warnings on last build.
- `Motor.c`: supports 4 motors (2 propulsion + 2 turning), PWM via TIM1 CH1-4. **New:** per-motor calibration (`MotorCal_t` with `left_scale/right_scale/left_offset/right_offset`), applied in `Motor_Go_PWM()` for propulsion motors only. Default: scale=1.0, offset=0.
- `Lora.c`: parses 4 downlink command types: `target`, `cmd` (stop/start/sensor), `motor` (direct L/R PWM), `mcal` (motor calibration). New `Lora_ExtractFloat()` helper.
- `Navigation.c`: PID heading controller + zone hold. `NAV_BASE_SPEED=60`, `NAV_HOLD_SPEED=30`, `NAV_ARRIVE_RADIUS=5m`, `NAV_DRIFT_RADIUS=8m`.
- `main.c` telemetry JSON now includes `mls/mrs/mlo/mro` (motor calibration fields, scale×100).
- Known issues from 2026-06-03 still apply except divider ratio has changed on the PCB: pH/turbidity formulas still need calibration with real liquids, but current PCB scaling is pH direct and turbidity ×3/2; GPS still needs outdoor fix test.

**WebUI state (Node.js + browser):**
- Complete three-panel rewrite on 2026-06-08.
- Left panel (260px, dark): real-time telemetry — connection, water quality (pH/turb/temp with raw+mV), GPS (fix/sat/lat/lon/bytes), IMU (roll/pitch/yaw/bytes), navigation (state/distance/heading), sequence, boot info, motor calibration values, collapsible raw JSON.
- Center panel: Leaflet map (always visible) + zone cards grid.
- Right panel: quick commands (stop/start/sensor), motor test (L/R sliders + presets), motor calibration (scale sliders + offset inputs), navigation monitor (big state display + distance/heading), zone detail.
- Settings drawer: serial port, manual send, sampling config, test samples, LLM config, zone management, sample history, communication log.
- Zone edit modal: species selection (builtin/custom), thresholds, geometry.
- 147 HTML element IDs, all wired in JS, all CSS classes defined.
- `server.js` unchanged — all new fields are transparent JSON pass-through.

**Hardware reality (as of 2026-06-03):**
- Connected: TB6612 (2 propulsion motors), LoRa (USART3), GPS (UART4), IMU901 (USART2), pH (ADC PC0), turbidity (ADC PC1 + digital PB0), DS18B20 (PB1).
- Tested: LoRa, motors, ADC paths, DS18B20 (25.38°C), GPS bytes arriving (indoor no fix).
- Not yet tested: outdoor GPS fix, IMU attitude, pH/turbidity calibration, navigation end-to-end.

**Next steps for teammate:**
1. Connect STM32 to PC via LoRa USB receiver, open WebUI, verify all telemetry fields update.
2. Motor test: set both to 50, observe speed difference, use calibration to equalize.
3. Outdoor GPS test: verify fix=1, lat/lon reasonable.
4. IMU test: rotate boat, verify yaw changes.
5. Sensor calibration: pH with known liquids, turbidity with clear/muddy water.
6. Navigation end-to-end: send target, verify boat moves to point.
7. Sampling workflow: verify zone cards update with real data.
8. LLM analysis: configure API key, verify risk analysis works.

**Why:** This captures the complete project state for handoff to a teammate who will continue hardware testing while the user designs the PCB expansion board.

**How to apply:** Read this file when resuming work. The WebUI is the primary debugging tool — everything can be tested through it. Related: [[boat-current-hardware]], [[boat-product-plan-2026-06-06]], [[boat-workflow-preferences]], [[boat-plan-and-competition-context]].
