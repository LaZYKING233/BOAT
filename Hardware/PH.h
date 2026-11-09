#ifndef __PH_H__
#define __PH_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"

#define PH_ADC_CHANNEL    ADC_CHANNEL_1

#define PH_VREF           3.3f
#define PH_ADC_RESOLUTION 16383.0f

#define PH_VOLTAGE_DIVIDER_RATIO  1.0f

void PH_Init(void);
float PH_ReadVoltage(void);
float PH_ReadValue(void);
float PH_GetAverageValue(uint8_t samples);

#ifdef __cplusplus
}
#endif

#endif
