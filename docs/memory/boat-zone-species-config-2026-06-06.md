---
name: boat-zone-species-config-2026-06-06
description: Per-zone cultured species configuration for aquaculture product UI and risk analysis
metadata: 
  node_type: memory
  type: project
  originSessionId: 66d13884-4af6-4c1d-9cdd-10c05ef332f1
---

On 2026-06-06, the user clarified that the aquaculture object/species should be configurable per fixed area/zone, not one global value for the whole system. Different zones may raise different fish or aquaculture species; for example A区 may raise one fish species while B区 raises another.

Design implications:

- Each fixed zone should store a manually selected cultured species/object, e.g. `speciesId` or `cultureObject`.
- The first version should not try to infer species automatically; manual selection/configuration is expected.
- First-version selection mode is built-in plus custom: provide common built-in options for fast setup, while allowing arbitrary custom species/object names. The accepted initial built-in list is 草鱼、鲫鱼、鲤鱼、鲈鱼、虾、蟹.
- Built-in options may ship with default threshold presets; custom names should require explicit threshold configuration or use a clearly labeled generic fallback.
- Thresholds, warning status, and LLM risk analysis must use the zone's configured species/object.
- Two zones with identical water readings may have different risk conclusions if their cultured species differ.
- If a zone has no configured species/object, the UI should show that configuration is incomplete; generic ranges may be shown only as fallback.
- STM32 firmware should not need to know species details for the first version; species config belongs in the WebUI/local backend/LLM side.

**Why:** The product is meant for real aquaculture use where different ponds/areas may raise different species, so a single global threshold/risk model would be misleading.

**How to apply:** Build the WebUI/backend data model around fixed zones with per-zone `speciesId`/`cultureObject`, latest sample, thresholds, and risk state. LLM prompts should include zone name, species, readings, thresholds, and recent trend. Related: [[boat-webui-product-direction-2026-06-06]], [[boat-zone-attribution-and-control-2026-06-06]], [[boat-plan-and-competition-context]].
