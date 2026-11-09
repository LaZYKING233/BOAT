#ifndef __TURBIDITY_H__
#define __TURBIDITY_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"

#define TURBIDITY_ADC_CHANNEL      ADC_CHANNEL_2
#define TURBIDITY_DIGITAL_PORT     GPIOB
#define TURBIDITY_DIGITAL_PIN      GPIO_PIN_0

#define TURBIDITY_VREF             3.3f
#define TURBIDITY_ADC_RESOLUTION   16383.0f

#define TURBIDITY_VOLTAGE_DIVIDER_RATIO  (2.0f / 3.0f)

#define TURBIDITY_THRESHOLD_LOW    1.0f
#define TURBIDITY_THRESHOLD_HIGH   4.0f

void Turbidity_Init(void);
float Turbidity_ReadVoltage(void);
float Turbidity_ReadNTU(void);
uint8_t Turbidity_IsHigh(void);
float Turbidity_GetAverageNTU(uint8_t samples);

#ifdef __cplusplus
}
#endif

#endif
