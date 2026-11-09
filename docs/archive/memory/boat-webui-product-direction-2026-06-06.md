---
name: boat-webui-product-direction-2026-06-06
description: WebUI/backend role and farmer-facing product direction clarified on 2026-06-06
metadata: 
  node_type: memory
  type: project
  originSessionId: 66d13884-4af6-4c1d-9cdd-10c05ef332f1
---

On 2026-06-06, after reviewing the teammate's `后端/` folder, the user clarified that the web interface is intended to become the final teacher-demonstration/product UI for aquaculture users, not just a research/debug dashboard. The current `后端/webui/webui/` is a Node.js + browser WebUI that reads LoRa serial JSON, displays telemetry, supports an advanced mode, and can generate/send map target JSON; it should be evolved into a farmer/operator-facing product interface.

The user also clarified the current deployment scope: the final/near-term teacher demonstration should run on the local computer only. The LoRa receiver connects to the demo PC over USB serial; the local Node.js service reads serial data; the browser on the same computer opens the WebUI (e.g. localhost). Phone access, other-device access, public cloud servers, and WeChat mini-program deployment are intentionally out of current scope because they would add server/miniprogram/network complexity and the teammate who could help is busy.

Desired final product behavior:

- Users open the website and can use it directly in an aquaculture production scenario.
- The default UI shows water-area status such as latest temperature, pH, turbidity, sampling time, and boat location.
- Each fixed area/zone should allow manual configuration of its cultured species/object; different zones may raise different fish/aquaculture species.
- First-version species selection should be built-in plus custom: common built-in options for quick setup, plus free-text custom names when needed.
- Species/object configuration drives threshold display, alert/risk status, and LLM risk-analysis context; do not assume one global species for the whole farm.
- For the local demo, the user chose a fixed set of 3-5 predefined aquaculture areas/sampling points (for example A/B/C zones), not arbitrary GIS drawing.
- The map shows the boat position and lets the user click a predefined target area/location so the boat can eventually travel there and update that area's water-quality data.
- Advanced mode is appropriate for serial ports, raw JSON, engineering/debug fields, and other technical details.
- The current demo topology is STM32/LoRa -> USB serial receiver -> local Node.js serial bridge/API -> local browser WebUI.
- Samples should be attributed to a predefined area primarily by operator intent: when a user selects/sends target zone A/B/C, the next valid sampling data updates that selected zone. GPS/location is for display, arrival/inside-zone validation, anomaly detection, and fallback only when no active selected zone exists. Unknown/stale areas should show "not sampled" or "stale" rather than healthy.
- Backend/LLM should eventually analyze whether current conditions are suitable for the cultured species and warn about risks such as summer typhoons, heavy rain, and other aquaculture hazards.

**Why:** The project story and implementation plan must optimize for a complete usable aquaculture product, not only STM32 bring-up or a developer serial monitor.

**How to apply:** When working on WebUI/backend features, prioritize farmer-readable dashboards with one card/row per predefined area, map/boat/target workflows, simple persistence, and actionable LLM risk advice. Keep debug/engineering controls behind advanced mode. Default to the simplest local serial-to-WebUI architecture; do not propose phone/cloud/miniprogram deployment or full GIS/geofencing editors unless the user explicitly reopens that scope. Related: [[boat-plan-and-competition-context]], [[boat-team-scope]], [[boat-workflow-preferences]].
