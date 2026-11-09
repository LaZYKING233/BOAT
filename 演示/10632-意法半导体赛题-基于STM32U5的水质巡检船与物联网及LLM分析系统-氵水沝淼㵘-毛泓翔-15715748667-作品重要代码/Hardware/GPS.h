#ifndef __GPS_H__
#define __GPS_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"

#define GPS_BUF_SIZE 256

typedef struct
{
    float latitude;       // 十进制度数（北纬为正，南纬为负）
    float longitude;      // 十进制度数（东经为正，西经为负）
    float speed_kph;      // 速度 km/h
    float course;         // 航向角 0-360度
    uint8_t fix;          // 定位状态: 0=未定位, 1=GPS, 2=差分GPS
    uint8_t satellite_num;// 参与定位的卫星数
    float altitude;       // 海拔高度 米
    uint8_t hour;         // UTC时
    uint8_t minute;       // UTC分
    uint8_t second;       // UTC秒
} GPS_Data_t;

extern GPS_Data_t gps_data;
extern uint8_t gps_data_ready;
extern uint8_t gps_rx_byte;
extern volatile uint32_t gps_rx_count;
extern volatile uint32_t gps_sentence_count;
extern char gps_last_sentence[GPS_BUF_SIZE];

void GPS_Init(void);
uint8_t GPS_ProcessByte(uint8_t ch);
float GPS_GetLatitude(void);
float GPS_GetLongitude(void);
float GPS_GetSpeed(void);
float GPS_GetCourse(void);
uint8_t GPS_IsFixed(void);

#ifdef __cplusplus
}
#endif

#endif
