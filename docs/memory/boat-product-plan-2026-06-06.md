---
name: boat-product-plan-2026-06-06
description: BOAT project milestones and implementation status as of 2026-06-07
metadata:
  node_type: memory
  type: project
  originSessionId: 66d13884-4af6-4c1d-9cdd-10c05ef332f1
---

As of 2026-06-08, all M1~M6 milestones are complete. WebUI rewritten as three-panel testing+product interface. Motor calibration system added (firmware + WebUI). The project is ready for hardware testing.

**Completed milestones:**
- M1: Zone cards + basic UI
- M2: Local storage (`data/zones.json` + `data/samples.jsonl`) + multi-point sampling state machine (8 points per zone, 30s stabilization, 5s interval, 1h duration)
- M3: Serial data parsing code ready (needs hardware validation)
- M4: STM32 downlink parsing (target/cmd/motor)
- M5: Navigation + zone hold (PID heading, 5m hold, 8m drift correction)
- M6: LLM risk analysis (cloud API + Ollama + rule fallback)

**Current frontend layout:** Dashboard-style with zone cards grid (left), small map (right top), zone detail (right bottom), settings drawer (gear icon), edit modal.

**Key files:**
- `后端/webui/webui/server.js` — Node.js backend with storage, sampling state machine, LLM service
- `后端/webui/webui/public/app.js` — Frontend with telemetry panel, zone cards, map, motor test/calibration
- `后端/webui/webui/public/index.html` — Three-panel layout (telemetry + zones + controls)
- `后端/webui/webui/public/styles.css` — Three-panel dashboard styles
- `Hardware/Navigation.c` — PID heading controller
- `Hardware/Lora.c` — Downlink JSON parsing (target/cmd/motor/mcal)
- `Hardware/Motor.c` — TB6612 driver with per-motor calibration
- `Core/Src/main.c` — Main loop with telemetry, command handling, navigation update
- `HANDOFF.md` — Teammate handoff document with testing checklist

**Code review fixes applied (2026-06-07):**
- `getVisibleZones()` → `visibleZones(false)` in server.js
- `getZoneCenter()` added to server.js
- Firmware `nt` heading error now multiplied by 100 before sending
- `nd` distance guarded for NAV_IDLE
- Risk level standardized to `'normal'` (not `'ok'`)
- `NAV_ARRIVED` dead enum removed
- Missing CSS classes added
- Stale README text updated
- PRODUCT_PLAN zone model updated to rectangle schema

**Next step:** Hardware testing (STM32 + LoRa + GPS + IMU). Keil ARM toolchain not on dev machine.

**Why:** All product features are implemented at code level; real validation requires physical hardware.

**How to apply:** Reference this memory when resuming work. Check `docs/PRODUCT_PLAN.md` for detailed protocol/model specs. Related: [[boat-current-hardware]], [[boat-zone-attribution-and-control-2026-06-06]], [[boat-zone-species-config-2026-06-06]], [[boat-workflow-preferences]].
