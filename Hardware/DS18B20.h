#ifndef __DS18B20_H__
#define __DS18B20_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"

#define DS18B20_PORT    GPIOB
#define DS18B20_PIN     GPIO_PIN_1

/* 非阻塞采集参数 */
#define DS18B20_CONV_MS      800U    /* 12bit 转换最长 750ms，留 50ms 余量 */
#define DS18B20_PERIOD_MS   1000U    /* 每秒启动一次转换 */

void DS18B20_Init(void);
uint8_t DS18B20_Reset(void);
void DS18B20_WriteByte(uint8_t data);
uint8_t DS18B20_ReadByte(void);

/**
 * @brief  推进非阻塞采集状态机，必须在主循环里反复调用。
 * @note   内部按 DS18B20_PERIOD_MS 启动转换，等 DS18B20_CONV_MS 后读回结果。
 *         单次调用最坏阻塞约 2ms（读暂存器时的临界区），不再阻塞 750ms。
 */
void DS18B20_Update(void);

/**
 * @brief  取最近一次有效温度（℃，非阻塞）。
 * @retval 有效时返回温度；尚未采到 / 读取失败返回 -1000.0f
 */
float DS18B20_GetTemp(void);

/** @retval 1 = 最近一次读数有效 */
uint8_t DS18B20_IsValid(void);

#ifdef __cplusplus
}
#endif

#endif
