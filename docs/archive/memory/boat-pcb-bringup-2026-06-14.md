---
name: boat-pcb-bringup-2026-06-14
description: PCB transfer bring-up status, divider changes, and current project repair on 2026-06-14
metadata:
  type: project
---

On 2026-06-14, the user reported that the hardware had been transferred fully onto a PCB. They tested with an older backup code copy (`E:\STM32\BOAT 26.6.8\BOAT`) and saw LoRa data in `2.py` but WebUI sensor display failed. The captured telemetry showed raw ADC data was alive (`phr≈9220`, `tbr≈3200-3330`, IMU valid) but computed `ph=0`, `tb=0`, and `tv=0`.

Root cause analysis:
- `ph=0` and `tb=0` were caused by stale firmware scaling that still multiplied both ADC voltages by the old 1/20 divider factor. With the new PCB, pH is direct to ADC and turbidity uses 2/3 divider. The old code reconstructed impossible voltages (e.g. pH mV around 37V), so pH/turbidity formulas clamped to 0.
- LoRa JSON was likely truncated because `lora_tx_buffer[256]` was too small for the expanded telemetry JSON. Truncated JSON caused the WebUI backend to fail parsing complete `data` messages.
- `tv=0` indicates DS18B20 read failure and remains a separate hardware bring-up issue (check PB1, 4.7k pull-up, VCC/GND, soldering).
- The current project `E:\STM32\BOAT` had been accidentally damaged by partial NanoEdge AI integration: active `neai_anomalydetection_*` calls and a malformed telemetry `ma` field broke `main.c`. The AI files should remain on disk but not be included/called for now because K5/Keil cannot load/recognize them.

Repairs applied to the current project only (`E:\STM32\BOAT`, not the backup):
- `Core/Src/main.c`: disabled active NanoEdge AI calls; removed telemetry `ma` field; fixed the broken `Lora_Printf` argument list; changed scaling to pH direct (`sensor_mv=adc_mv`) and turbidity `*3/2`; changed boot JSON from `div:20` to `phdiv:100,tbdiv:150`.
- `Hardware/Lora.c`: increased `lora_tx_buffer` from 256 to 512.
- `Hardware/PH.h`: set `PH_VOLTAGE_DIVIDER_RATIO` to `1.0f`.
- `Hardware/Turbidity.h`: set `TURBIDITY_VOLTAGE_DIVIDER_RATIO` to `(1.0f / 2.0f)`.
- `Hardware/DS18B20.h`: DS18B20 connected to PB1 (GPIO_PIN_1).
- `Hardware/DS18B20.c`: fixed 85°C issue by polling for conversion completion instead of fixed 750ms delay, and rejecting default 0x0550 value.
- `后端/webui/webui/public/app.js`: updated boot divider display to handle `phdiv/tbdiv`.
- `README.md` and `HANDOFF.md`: updated sensor wiring/divider notes.

Verification performed by search/read tools:
- No active `neai_`, `NanoEdge`, `libneai`, `"ma"`, or `TELEMETRY_DIVIDER_SCALE` references remain under `Core/Src` or `Hardware`.
- `Hardware/Lora.c` now has `lora_tx_buffer[512]`.
- `PH.h`, `Turbidity.h`, and `main.c` scale macros match the new PCB divider assumptions.
- Earlier read-only project exploration found `MDK-ARM/BOAT.uvprojx` referenced 48 files with no missing file references, no duplicate paths/groups, and no AI files referenced. Bash integrity script could not be rerun because the tool safety classifier was temporarily unavailable.

**Why:** The new PCB changed the analog front-end; old firmware scaling and a partially added AI feature made the current project fail to build and fail to display telemetry.

**How to apply:** After this repair, rebuild the current project in Keil. Expected telemetry should contain complete JSON lines ending in `}` and pH/turbidity should no longer clamp to 0 if ADC raw values are similar. If temperature still reports `tv=0`, debug DS18B20 hardware separately. Related: [[boat-code-state-2026-06-08]], [[boat-sensor-bringup-status]], [[boat-current-hardware]].
