#include "GPS.h"
#include "usart.h"
#include <string.h>
#include <stdlib.h>

GPS_Data_t gps_data;
uint8_t gps_data_ready = 0;
volatile uint32_t gps_rx_count = 0;
volatile uint32_t gps_sentence_count = 0;
char gps_last_sentence[GPS_BUF_SIZE];

static uint8_t gps_buf[GPS_BUF_SIZE];
static uint16_t gps_buf_idx = 0;

static int32_t gps_str2num(uint8_t *str, uint8_t *float_len)
{
    int32_t num = 0;
    uint8_t flen = 0;
    uint8_t neg = 0;

    if (*str == '-')
    {
        neg = 1;
        str++;
    }

    while (*str >= '0' && *str <= '9')
    {
        num = num * 10 + (*str - '0');
        str++;
    }

    if (*str == '.')
    {
        str++;
        while (*str >= '0' && *str <= '9')
        {
            num = num * 10 + (*str - '0');
            flen++;
            str++;
        }
    }

    if (float_len != NULL) *float_len = flen;

    if (neg) num = -num;
    return num;
}

// 将度分格式(ddmm.mmmm)转换为十进制度(dd.ddddd)
static float gps_dm_to_degree(int32_t dm, uint8_t flen)
{
    // 先将dm还原为实际值（考虑小数位数）
    float dm_f = (float)dm;
    uint8_t i;
    for (i = 0; i < flen; i++) dm_f /= 10.0f;

    int32_t deg = (int32_t)(dm_f / 100.0f);
    float min = dm_f - (float)(deg * 100);

    return (float)deg + min / 60.0f;
}

// 解析$GNRMC
static void gps_parse_rmc(uint8_t *buf)
{
    uint8_t *p = buf;
    uint8_t param_idx = 0;
    uint8_t *param_start;
    uint16_t param_len;
    int32_t num;
    uint8_t flen;

    while (*p != '\0' && *p != 0x0D && *p != 0x0A)
    {
        param_start = p;
        param_len = 0;
        while (*p != ',' && *p != '*' && *p != '\0' && *p != 0x0D && *p != 0x0A)
        {
            param_len++;
            p++;
        }

        switch (param_idx)
        {
            case 1: // UTC时间 hhmmss.sss
                if (param_len >= 6)
                {
                    num = gps_str2num(param_start, &flen);
                    gps_data.hour = (num / 10000000) % 100;
                    gps_data.minute = (num / 100000) % 100;
                    gps_data.second = (num / 1000) % 100;
                }
                break;

            case 2: // 状态 A=有效 V=无效
                if (param_len > 0 && *param_start == 'A')
                    gps_data.fix = (gps_data.fix > 0) ? gps_data.fix : 1;
                else if (param_len > 0 && *param_start == 'V')
                    gps_data.fix = 0;
                break;

            case 3: // 纬度 ddmm.mmmm
                if (param_len > 0)
                {
                    num = gps_str2num(param_start, &flen);
                    gps_data.latitude = gps_dm_to_degree(num, flen);
                }
                break;

            case 4: // N/S
                if (param_len > 0 && *param_start == 'S')
                    gps_data.latitude = -gps_data.latitude;
                break;

            case 5: // 经度 dddmm.mmmm
                if (param_len > 0)
                {
                    num = gps_str2num(param_start, &flen);
                    gps_data.longitude = gps_dm_to_degree(num, flen);
                }
                break;

            case 6: // E/W
                if (param_len > 0 && *param_start == 'W')
                    gps_data.longitude = -gps_data.longitude;
                break;

            case 7: // 速度(节) 转换为km/h
                if (param_len > 0)
                {
                    num = gps_str2num(param_start, &flen);
                    float speed_knots = (float)num;
                    uint8_t i;
                    for (i = 0; i < flen; i++) speed_knots /= 10.0f;
                    gps_data.speed_kph = speed_knots * 1.852f;
                }
                break;

            case 8: // 航向角
                if (param_len > 0)
                {
                    num = gps_str2num(param_start, &flen);
                    gps_data.course = (float)num;
                    uint8_t i;
                    for (i = 0; i < flen; i++) gps_data.course /= 10.0f;
                }
                break;
        }

        param_idx++;
        if (*p == ',') p++;
        else break;
    }
}

// 解析$GNGGA
static void gps_parse_gga(uint8_t *buf)
{
    uint8_t *p = buf;
    uint8_t param_idx = 0;
    uint8_t *param_start;
    uint16_t param_len;
    int32_t num;
    uint8_t flen;

    while (*p != '\0' && *p != 0x0D && *p != 0x0A)
    {
        param_start = p;
        param_len = 0;
        while (*p != ',' && *p != '*' && *p != '\0' && *p != 0x0D && *p != 0x0A)
        {
            param_len++;
            p++;
        }

        switch (param_idx)
        {
            case 6: // 定位质量 0=未定位 1=GPS 2=差分
                if (param_len > 0)
                {
                    num = gps_str2num(param_start, NULL);
                    gps_data.fix = (uint8_t)num;
                }
                break;

            case 7: // 卫星数
                if (param_len > 0)
                {
                    num = gps_str2num(param_start, NULL);
                    gps_data.satellite_num = (uint8_t)num;
                }
                break;

            case 9: // 海拔高度
                if (param_len > 0)
                {
                    num = gps_str2num(param_start, &flen);
                    gps_data.altitude = (float)num;
                    uint8_t i;
                    for (i = 0; i < flen; i++) gps_data.altitude /= 10.0f;
                }
                break;
        }

        param_idx++;
        if (*p == ',') p++;
        else break;
    }
}

uint8_t GPS_ProcessByte(uint8_t ch)
{
    gps_rx_count++;

    if (ch == '$')
    {
        gps_buf_idx = 0;
        gps_buf[gps_buf_idx++] = ch;
    }
    else if (gps_buf_idx > 0)
    {
        if (gps_buf_idx < GPS_BUF_SIZE - 1)
        {
            gps_buf[gps_buf_idx++] = ch;
        }

        if (ch == '\n' || ch == '\r')
        {
            gps_buf[gps_buf_idx] = '\0';
            gps_sentence_count++;
            strncpy(gps_last_sentence, (char *)gps_buf, GPS_BUF_SIZE - 1);
            gps_last_sentence[GPS_BUF_SIZE - 1] = '\0';

            // 判断NMEA消息类型
            if (gps_buf[3] == 'R' && gps_buf[4] == 'M' && gps_buf[5] == 'C')
            {
                gps_parse_rmc(gps_buf);
                gps_data_ready = 1;
            }
            else if (gps_buf[3] == 'G' && gps_buf[4] == 'G' && gps_buf[5] == 'A')
            {
                gps_parse_gga(gps_buf);
            }

            gps_buf_idx = 0;
            return 1;
        }
    }

    return 0;
}

void GPS_Init(void)
{
    memset(&gps_data, 0, sizeof(GPS_Data_t));
    gps_data_ready = 0;
    gps_rx_count = 0;
    gps_sentence_count = 0;
    gps_last_sentence[0] = '\0';
    gps_buf_idx = 0;

    // 启动UART4中断接收
    HAL_UART_Receive_IT(&huart4, &gps_rx_byte, 1);
}

float GPS_GetLatitude(void)
{
    return gps_data.latitude;
}

float GPS_GetLongitude(void)
{
    return gps_data.longitude;
}

float GPS_GetSpeed(void)
{
    return gps_data.speed_kph;
}

float GPS_GetCourse(void)
{
    return gps_data.course;
}

uint8_t GPS_IsFixed(void)
{
    return gps_data.fix;
}
