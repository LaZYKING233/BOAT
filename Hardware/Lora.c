#include "Lora.h"
#include "usart.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

extern UART_HandleTypeDef huart3;

/* 遥测字段持续增加（新增 6 个 PID 增益），512 字节已接近上限，
 * 留出余量避免 JSON 被 vsnprintf 截断导致整行解析失败。 */
static char lora_tx_buffer[768];

/* --- LoRa 下行接收 --- */
#define LORA_LINE_MAX    256

uint8_t                  lora_rx_byte = 0;
static uint16_t          lora_rx_len = 0;
static char              lora_line[LORA_LINE_MAX];
static Lora_TargetCmd_t  lora_pending_cmd = {0};
static uint8_t           lora_cmd_ready = 0;
static Lora_Cmd_t        lora_pending_generic_cmd = {0};
static uint8_t           lora_generic_cmd_ready = 0;
static Lora_MotorCmd_t   lora_pending_motor_cmd = {0};
static uint8_t           lora_motor_cmd_ready = 0;
static Lora_MotorCalCmd_t lora_pending_motorcal_cmd = {0};
static uint8_t           lora_motorcal_cmd_ready = 0;
static Lora_PidCmd_t     lora_pending_pid_cmd = {0};
static uint8_t           lora_pid_cmd_ready = 0;
static uint16_t          lora_rx_count = 0;

void Lora_Init(void)
{
    
}

void Lora_SendString(const char *str)
{
    HAL_UART_Transmit(&huart3, (uint8_t *)str, strlen(str), 100);
}

void Lora_SendBytes(uint8_t *data, uint16_t len)
{
    HAL_UART_Transmit(&huart3, data, len, 100);
}

void Lora_Printf(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    vsnprintf(lora_tx_buffer, sizeof(lora_tx_buffer), fmt, args);
    va_end(args);
    Lora_SendString(lora_tx_buffer);
}

void Lora_SendInt(const char *label, int32_t value)
{
    snprintf(lora_tx_buffer, sizeof(lora_tx_buffer), "%s: %ld\r\n", label, (long)value);
    Lora_SendString(lora_tx_buffer);
}

void Lora_SendFloat(const char *label, float value, uint8_t decimals)
{
    char format[32];
    snprintf(format, sizeof(format), "%s: %%.%df\r\n", label, decimals);
    snprintf(lora_tx_buffer, sizeof(lora_tx_buffer), format, value);
    Lora_SendString(lora_tx_buffer);
}

void Lora_SendNewLine(void)
{
    Lora_SendString("\r\n");
}

/* ---------- 下行接收 ---------- */

void Lora_StartReceive(void)
{
    lora_rx_len = 0;
    lora_cmd_ready = 0;
    lora_rx_count = 0;
    HAL_UART_Receive_IT(&huart3, &lora_rx_byte, 1);
}

/* 从 JSON 行中提取 int32 字段: "key":12345 */
static int32_t Lora_ExtractInt(const char *json, const char *key, int32_t def)
{
    char search[32];
    const char *p;
    snprintf(search, sizeof(search), "\"%s\":", key);
    p = strstr(json, search);
    if (!p) return def;
    p += strlen(search);
    return (int32_t)strtol(p, NULL, 10);
}

/* 从 JSON 行中提取字符串字段: "key":"value" */
static void Lora_ExtractStr(const char *json, const char *key, char *out, uint16_t out_size)
{
    char search[32];
    const char *p, *end;
    uint16_t len;

    out[0] = '\0';
    snprintf(search, sizeof(search), "\"%s\":\"", key);
    p = strstr(json, search);
    if (!p) return;
    p += strlen(search);
    end = strchr(p, '"');
    if (!end) return;
    len = (uint16_t)(end - p);
    if (len >= out_size) len = out_size - 1;
    memcpy(out, p, len);
    out[len] = '\0';
}

/* 从 JSON 行中提取 float 字段: "key":1.234 */
static float Lora_ExtractFloat(const char *json, const char *key, float def)
{
    char search[32];
    const char *p;
    snprintf(search, sizeof(search), "\"%s\":", key);
    p = strstr(json, search);
    if (!p) return def;
    p += strlen(search);
    return strtof(p, NULL);
}

/* 收到完整一行后解析 */
static void Lora_ProcessLine(const char *line)
{
    char type[16];
    char json_line[LORA_LINE_MAX];
    const char *json_start;
    const char *json_end;
    uint16_t json_len;

    lora_rx_count++;

    json_start = strchr(line, '{');
    if (!json_start) return;

    json_end = strchr(json_start, '}');
    if (!json_end) return;

    json_len = (uint16_t)(json_end - json_start + 1);
    if (json_len >= sizeof(json_line)) return;

    memcpy(json_line, json_start, json_len);
    json_line[json_len] = '\0';
    line = json_line;

    Lora_ExtractStr(line, "t", type, sizeof(type));

    if (strcmp(type, "target") == 0)
    {
        Lora_TargetCmd_t cmd;
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;
        Lora_ExtractStr(line, "zone", cmd.zone, sizeof(cmd.zone));
        cmd.lat = Lora_ExtractInt(line, "lat", 0);
        cmd.lon = Lora_ExtractInt(line, "lon", 0);
        cmd.r   = Lora_ExtractInt(line, "r", 5);
        cmd.ar  = Lora_ExtractInt(line, "ar", 5);
        cmd.rr  = Lora_ExtractInt(line, "rr", cmd.r > 0 ? cmd.r : 8);
        cmd.bm  = Lora_ExtractInt(line, "bm", 2);
        cmd.bclat = Lora_ExtractInt(line, "bclat", 0);
        cmd.bclon = Lora_ExtractInt(line, "bclon", 0);
        cmd.blen = Lora_ExtractFloat(line, "blen", 0.0f);
        cmd.bwid = Lora_ExtractFloat(line, "bwid", 0.0f);
        lora_pending_cmd = cmd;
        lora_cmd_ready = 1;
    }
    else if (strcmp(type, "cmd") == 0)
    {
        Lora_Cmd_t cmd;
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;
        Lora_ExtractStr(line, "cmd", cmd.cmd, sizeof(cmd.cmd));
        lora_pending_generic_cmd = cmd;
        lora_generic_cmd_ready = 1;
    }
    else if (strcmp(type, "motor") == 0)
    {
        Lora_MotorCmd_t cmd;
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;
        cmd.l = Lora_ExtractInt(line, "l", 0);
        cmd.r = Lora_ExtractInt(line, "r", 0);
        lora_pending_motor_cmd = cmd;
        lora_motor_cmd_ready = 1;
    }
    else if (strcmp(type, "mcal") == 0)
    {
        Lora_MotorCalCmd_t cmd;
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;
        cmd.ls = Lora_ExtractFloat(line, "ls", 1.0f);
        cmd.rs = Lora_ExtractFloat(line, "rs", 1.0f);
        cmd.lo = (int16_t)Lora_ExtractInt(line, "lo", 0);
        cmd.ro = (int16_t)Lora_ExtractInt(line, "ro", 0);
        lora_pending_motorcal_cmd = cmd;
        lora_motorcal_cmd_ready = 1;
    }
    else if (strcmp(type, "pid") == 0)
    {
        Lora_PidCmd_t cmd;
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;

        /* 缺省用 -1 表示"本次未提供"，由 Navigation_SetPid 跳过，
         * 这样上位机可以只下发想改的那一项。 */
        cmd.hkp = Lora_ExtractFloat(line, "hkp", -1.0f);
        cmd.hki = Lora_ExtractFloat(line, "hki", -1.0f);
        cmd.hkd = Lora_ExtractFloat(line, "hkd", -1.0f);
        cmd.xkp = Lora_ExtractFloat(line, "xkp", -1.0f);
        cmd.xki = Lora_ExtractFloat(line, "xki", -1.0f);
        cmd.xkd = Lora_ExtractFloat(line, "xkd", -1.0f);

        lora_pending_pid_cmd = cmd;
        lora_pid_cmd_ready = 1;
    }
}

void Lora_ProcessByte(uint8_t byte)
{
    if (byte == '\n' || lora_rx_len >= LORA_LINE_MAX - 1)
    {
        if (lora_rx_len > 0)
        {
            /* 去掉末尾 \r */
            if (lora_line[lora_rx_len - 1] == '\r')
                lora_rx_len--;
            lora_line[lora_rx_len] = '\0';
            Lora_ProcessLine(lora_line);
        }
        lora_rx_len = 0;
        lora_line[0] = '\0';
        return;
    }

    if (byte == '{' && lora_rx_len > 0 && lora_line[0] != '{')
    {
        lora_rx_len = 0;
    }

    lora_line[lora_rx_len++] = (char)byte;
}

uint8_t Lora_HasPendingCommand(void)
{
    return lora_cmd_ready;
}

uint8_t Lora_GetPendingCommand(Lora_TargetCmd_t *cmd)
{
    if (!lora_cmd_ready) return 0;
    *cmd = lora_pending_cmd;
    lora_cmd_ready = 0;
    return 1;
}

uint8_t Lora_HasPendingCmd(void)
{
    return lora_generic_cmd_ready;
}

uint8_t Lora_GetPendingCmd(Lora_Cmd_t *cmd)
{
    if (!lora_generic_cmd_ready) return 0;
    *cmd = lora_pending_generic_cmd;
    lora_generic_cmd_ready = 0;
    return 1;
}

uint8_t Lora_HasPendingMotorCmd(void)
{
    return lora_motor_cmd_ready;
}

uint8_t Lora_GetPendingMotorCmd(Lora_MotorCmd_t *cmd)
{
    if (!lora_motor_cmd_ready) return 0;
    *cmd = lora_pending_motor_cmd;
    lora_motor_cmd_ready = 0;
    return 1;
}

uint8_t Lora_HasPendingMotorCalCmd(void)
{
    return lora_motorcal_cmd_ready;
}

uint8_t Lora_GetPendingMotorCalCmd(Lora_MotorCalCmd_t *cmd)
{
    if (!lora_motorcal_cmd_ready) return 0;
    *cmd = lora_pending_motorcal_cmd;
    lora_motorcal_cmd_ready = 0;
    return 1;
}

uint8_t Lora_HasPendingPidCmd(void)
{
    return lora_pid_cmd_ready;
}

uint8_t Lora_GetPendingPidCmd(Lora_PidCmd_t *cmd)
{
    if (!lora_pid_cmd_ready) return 0;
    *cmd = lora_pending_pid_cmd;
    lora_pid_cmd_ready = 0;
    return 1;
}
