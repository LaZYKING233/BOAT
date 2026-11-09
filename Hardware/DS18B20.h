#ifndef __DS18B20_H__
#define __DS18B20_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"

#define DS18B20_PORT    GPIOB
#define DS18B20_PIN     GPIO_PIN_1

void DS18B20_Init(void);
uint8_t DS18B20_Reset(void);
void DS18B20_WriteByte(uint8_t data);
uint8_t DS18B20_ReadByte(void);
float DS18B20_GetTemp(void);
float DS18B20_GetTempMultiple(uint8_t samples);

#ifdef __cplusplus
}
#endif

#endif
