---
name: boat-zone-attribution-and-control-2026-06-06
description: Fixed-area sample attribution and station-keeping requirement for the boat demo
metadata: 
  node_type: memory
  type: project
  originSessionId: 66d13884-4af6-4c1d-9cdd-10c05ef332f1
---

On 2026-06-06, the user chose fixed 3-5 aquaculture areas/sampling points for the local demo and clarified sample attribution/control behavior:

- Sample data should primarily belong to the operator-selected target zone. If the user clicks/sends target zone A, the next valid sample should update zone A.
- GPS should be used for display, arrival/inside-zone validation, anomaly detection, and fallback only when no active selected zone exists. Do not silently reassign a sample to another zone purely because GPS is closer to that zone.
- If GPS strongly disagrees with the selected zone, show a warning such as location validation failed/needs confirmation.
- Future downlink target commands should carry both logical zone identity and navigation reference, e.g. `{ "t":"target", "zone":"A", "lat":..., "lon":..., "r":5 }`. `zone` is the attribution key; `lat/lon/r` guide navigation/holding.
- The user selected 5 meters as the first-version fixed-zone holding/arrival/validation radius. Treat this as an initial tunable default, not a permanent value.
- Future electrical/control firmware should not only drive once to a point; after reaching the selected zone it should enter a hold/station-keeping state to remain inside the zone during sampling and resist wind/wave drift.
- Control should likely use GPS for low-rate position error and IMU yaw for heading stabilization. A simple first version can use an inner/outer radius: inside the inner radius use minimal correction, outside the outer radius return toward the zone center.
- Keep low-level TB6612 control in `Hardware/`; pure control algorithms such as heading/zone-hold/PID should go under `System/` when implemented.

On 2026-06-07, the WebUI/backend M2 sampling workflow refined the local-demo control semantics: persisted zones are axis-aligned rectangles defined by center latitude/longitude plus north-south length and east-west width. Targeting still sends the rectangle center. Arrival logic should prefer getting within 1m of the center; if the boat is within 5m but cannot reach 1m within 1 minute, degrade to accepting the 5m radius. If the boat does not enter 5m within 10 minutes, pause and warn for user handling. After arrival, wait 30s for sensor stabilization, then save samples every 5s for 1 hour; if GPS leaves 5m during sampling, pause and warn, then re-stabilize after returning. Manual override sampling is allowed only as an explicitly marked advanced fallback when GPS/arrival is not usable.

**Why:** This supports the product story of operator-guided fixed-zone aquaculture sampling while keeping the demo reliable even when GPS is imperfect.

**How to apply:** Design WebUI/backend state around an `activeTargetZone`; store latest readings per zone; treat GPS as validation rather than sole ownership; when implementing navigation, include `GO_TO_ZONE`, `HOLD_IN_ZONE`, `SAMPLING`, `STOP/FAULT` style states. Related: [[boat-webui-product-direction-2026-06-06]], [[boat-workflow-preferences]], [[boat-plan-and-competition-context]].
