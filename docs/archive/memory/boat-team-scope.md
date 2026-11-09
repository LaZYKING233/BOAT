---
name: boat-team-scope
description: "User's responsibility scope within the STM32无人船 team"
metadata: 
  node_type: memory
  type: project
  originSessionId: 090257f9-2725-4f5f-a4e1-c02a976f2aa6
---

The user's responsibility scope changed on 2026-06-06. The user no longer wants to act only as the electrical-control / MCU person. They now intend to own and integrate the complete project as a usable aquaculture unmanned-boat product: STM32 firmware, motor/navigation control, sensors, LoRa protocol, WebUI/frontend, local/backend data handling, map interaction, persistent area data, and cloud/LLM risk analysis. Teammates may still provide hardware/mechanical work or frontend/backend pieces, but the user expects to understand and integrate the whole product.

**Why:** Future recommendations should not artificially stop at MCU interfaces. The project narrative is now a complete water-aquaculture product for farmers/operators, not a single electrical-control module or a pure research/engineering demo.

**How to apply:** Still prioritize safe STM32 bring-up and clear interfaces, but plan end-to-end vertical slices: STM32 telemetry -> LoRa/WebUI display -> map/area data -> downlink command -> navigation -> storage -> LLM aquaculture risk advice. Related: [[boat-plan-and-competition-context]], [[boat-workflow-preferences]].
