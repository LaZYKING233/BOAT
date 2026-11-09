---
name: boat-plan-and-competition-context
description: Competition and proposal context for the STM32无人船 project
metadata: 
  node_type: memory
  type: project
  originSessionId: 090257f9-2725-4f5f-a4e1-c02a976f2aa6
---

The project proposal in `资料/智航清泓.docx` is titled “智航清泓：基于STM32与4G云LLM的无人船水质监测与预警系统”. It targets the 2026 全国大学生嵌入式芯片与系统设计竞赛 · 意法半导体赛道, primarily 选题六 IoT, with optional/secondary 选题一 嵌入式人工智能.

Planned full system in the proposal:

- STM32 controls boat movement and sensor sampling.
- Water quality sensing: pH, turbidity, DS18B20 temperature; optional dissolved oxygen.
- Wide-area communication originally planned as Fibocom L610 4G using MQTT/HTTP.
- Cloud server invokes an LLM API (通义千问/DeepSeek/智谱等) to generate water-quality diagnosis text.
- WeChat mini program displays live data/history/LLM conclusions and sends commands such as start sampling and return.
- Optional edge-AI obstacle avoidance using K230 CanMV/OpenMV.
- Optional GPS-based automatic cruise.

As clarified by the user on 2026-06-06, the product narrative should be a complete usable aquaculture system for farmers/operators, not a researcher-facing dashboard. The default web interface should show area-level water status such as latest temperature/pH/turbidity, boat position, sampling points, configured cultured species/object, and actionable risks. For the local demo, area-level display should use 3-5 predefined aquaculture areas/sampling points rather than a complex arbitrary GIS editor. Advanced/debug mode may show serial ports, raw JSON, and engineering fields. The user wants map-click target selection to eventually make the boat travel to a selected fixed area/point and update that area's water-quality data. Sample attribution should follow the selected target zone first; GPS validates/displays/fallbacks rather than solely deciding ownership. Backend/LLM analysis should eventually combine sensor/history/location data with aquaculture context and external risks such as summer typhoons and heavy rain to judge whether conditions suit the current aquatic species and to warn about potential hazards.

Also clarified on 2026-06-06: the near-term/final teacher demonstration should run on the local computer only. The intended topology is STM32/LoRa -> USB serial receiver on demo PC -> local Node.js service -> local browser WebUI. Phone/other-device access, cloud server deployment, and WeChat mini-program delivery are deferred and should not be treated as current requirements unless the user reopens that scope.

The competition PDF `资料/733a60ac454e4a959c5f9e4dbb747e4b.pdf` is the 2026 ST赛道芯片应用赛道选题指南. It says IoT projects should use wireless node data transmission and recommends ST sensors + MCU, NanoEdge AI/STM32Cube.AI, TouchGFX, and STM32U5/STM32WLE5/STM32WB/WBA/STM32H5 products. The current STM32U5 board is therefore aligned with 选题六. The PDF also notes embedded-AI projects are expected to run edge AI on STM32/MPU using STM32Cube.AI/NanoEdge AI; cloud LLM is useful for product value but may not fully satisfy “端侧AI” expectations by itself.

**Why:** The proposal is larger than the current hardware state, but the user's target is now an end-to-end product demonstration. The MVP should be chosen as vertical slices that prove product value, not isolated subsystem demos.

**How to apply:** Treat IoT as the main track. Build in vertical slices: reliable STM32 telemetry -> local WebUI farmer-facing display -> area/map interaction -> downlink command -> navigation/control -> history storage -> LLM risk/advice. If time is short, keep the default UI simple and usable, keep raw/debug data in advanced mode, and make LLM/weather/area logic believable even if some values are calibrated later. Prefer local-computer demo reliability over cloud/mobile scope. Related: [[boat-current-hardware]], [[boat-code-state-2026-06-03]], [[boat-team-scope]], [[boat-webui-product-direction-2026-06-06]].
