---
name: boat-workflow-preferences
description: "User's preferred workflow for CubeMX pins and code changes in STM32 BOAT project"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 090257f9-2725-4f5f-a4e1-c02a976f2aa6
---

For the STM32 BOAT project, the user wants pin/peripheral assignment changes to be done in STM32CubeMX by the user, not directly by Claude. When a change requires modifying pins or CubeMX peripheral setup, tell the user exactly what to change in CubeMX and wait for them to generate code. For non-pin code changes, Claude may edit code directly and then report what changed.

The user also wants code organized by module and kept reasonably small: avoid putting long mixed logic into one source file. Hardware-related module code should live under `Hardware/` (for example motor, LoRa, GPS, IMU, water-quality sensors). Pure software algorithm code with no direct hardware dependency should live under `System/` (for example PID calculation, control/path algorithms, filters, protocol state machines); create and add that folder to the Keil project when first needed.

On 2026-06-06, the user added a standing preference: at the end of each conversation, check whether the project memory and `README.md` need updates. If the conversation changed project goals, responsibility scope, hardware status, protocol, architecture, code organization, or verified build/bring-up status, update the relevant memory file(s) and README before wrapping up. Do not force meaningless edits when nothing persistent changed; report if no update was needed. Full automatic enforcement would require a Claude Code hook, but meaningful README/memory updates still require judgment about what changed.

For UI/backend planning, default to a local-computer teacher-demo architecture: LoRa USB serial receiver on the demo PC, local Node.js serial bridge/API, and local browser WebUI. Do not suggest phone access, LAN multi-device access, cloud server deployment, account systems, or WeChat mini-program work unless the user explicitly asks to expand scope. For the demo UI area model, default to 3-5 predefined aquaculture areas/sampling points with simple latest-reading/risk cards; do not build full GIS/geofencing/region CRUD unless requested.

For the now full-project scope, prefer lightweight planning before implementation: document the product flow, core data/domain model, STM32/WebUI/LLM interface contracts, and milestone checklist, then build small end-to-end vertical slices with verification. Avoid both extremes: do not code randomly without shared interfaces, and do not spend too long on a huge speculative full-system design before producing a working slice.

**Why:** Keeping pin assignments visible and managed in CubeMX makes the project easier for the user and teammates to inspect later. Keeping README/memory current prevents context loss between long STM32/boat sessions.

**How to apply:** Before editing generated peripheral files or changing pin mappings, stop and provide CubeMX instructions. For driver/application logic fixes that do not change pins, proceed directly when requested. Before ending a substantive turn, update README/memory when persistent facts changed. Related: [[boat-code-state-2026-06-03]], [[boat-current-hardware]], [[boat-team-scope]], [[boat-plan-and-competition-context]].
