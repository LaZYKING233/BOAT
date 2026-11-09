---
name: boat-current-hardware
description: Current physical hardware wiring for the STM32 boat project as of 2026-06-14 PCB bring-up
metadata:
  node_type: memory
  type: project
  originSessionId: 090257f9-2725-4f5f-a4e1-c02a976f2aa6
---

As of the 2026-06-14 PCB transfer/bring-up, the boat hardware is no longer just the earlier minimal flying-wire setup. The current PCB/project wiring is:

- Two propulsion motors through a TB6612 motor driver.
- TB6612 wiring:
  - PWMA -> PE9 / TIM1_CH1
  - AIN2 -> PC9
  - AIN1 -> PC8
  - STBY -> PD4
  - BIN2 -> PC11
  - BIN1 -> PC10
  - PWMB -> PE11 / TIM1_CH2
- LoRa module wiring:
  - PB10/PB11 UART pair; in the Cube project PB10 is USART3_TX and PB11 is USART3_RX.
- GPS:
  - PA0/PA1 UART4, 38400 baud.
- IMU901:
  - PA2/PA3 USART2, 115200 baud.
- pH:
  - PC0 / ADC1_IN1, PCB新版直连 ADC（不分压）。
- Turbidity:
  - PC1 / ADC1_IN2 analog, PCB新版 2/3 分压（ADC = sensor output ×2/3）。
  - PB0 digital DOUT.
- DS18B20:
  - PB1 GPIO, requires 4.7k pull-up to 3.3V.

Historical note: on 2026-06-03 only motors and LoRa had been physically connected and verified; that note is superseded for current PCB work.

**Why:** Debugging and firmware scaling must follow the PCB wiring, especially pH direct ADC, turbidity ×3/2 reconstruction, and DS18B20 on PB1.

**How to apply:** For PCB bring-up, test one module at a time in WebUI/LoRa telemetry: LoRa JSON completeness, ADC raw/mV for pH/turbidity, DS18B20 temperature on PB1, IMU attitude, GPS outdoor fix, motor calibration, then navigation. Related: [[boat-pcb-bringup-2026-06-14]], [[boat-code-state-2026-06-08]], [[boat-plan-and-competition-context]].
