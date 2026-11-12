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
static Lora_HeadingCmd_t lora_pending_heading_cmd = {0};
static uint8_t           lora_heading_cmd_ready = 0;
static uint16_t          lora_rx_count = 0;

/* 累计收到的字节数。下行不工作时用它区分"物理上没收到"和"收到了但没解析出来"：
 * 前者是接线/模块模式问题，后者是固件解析问题，处理方向完全相反。 */
volatile uint32_t        lora_rx_bytes = 0;

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

/* 紧凑文本指令（JSON 太长，在丢字节的下行链路上基本传不过去）
 *
 *   G<纬度×1e6>,<经度×1e6>        例如 G34500100,10400010   -> 19 字符
 *   P<hkp×1000>,<hki×1000>,<hkd×1000>
 *
 * 实测下行报文超过约 40 字节就开始丢字节，147 字节的 target 几乎必然被截断。
 * 紧凑格式把关键命令压到 20 字节以内，显著提高一次送达率。
 */
static uint8_t Lora_ParseCompact(const char *line)
{
    char *p;
    char *comma;

    if (line[0] == 'G' || line[0] == 'g')
    {
        p = (char *)line + 1;
        comma = strchr(p, ',');
        if (!comma) return 0;

        Lora_TargetCmd_t cmd;
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;

        /* 上位机用 1e6 缩放（精度约 0.1m），固件内部统一按 1e7 使用 */
        cmd.lat = (int32_t)(strtol(p, NULL, 10) * 10);
        cmd.lon = (int32_t)(strtol(comma + 1, NULL, 10) * 10);

        /* 紧凑格式不带半径，用演示默认值；需要精细控制时再用完整 JSON 下发 */
        cmd.r  = 6;
        cmd.ar = 2;
        cmd.rr = 8;
        cmd.bm = 4;

        lora_pending_cmd = cmd;
        lora_cmd_ready = 1;
        return 1;
    }

    if (line[0] == 'T' || line[0] == 't')
    {
        /* T<毫秒>  设置遥测周期，用于寻找"够实时又能让下行通过"的平衡点 */
        Lora_Cmd_t cmd;
        long ms = strtol((char *)line + 1, NULL, 10);
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;
        snprintf(cmd.cmd, sizeof(cmd.cmd), "T%ld", ms);
        lora_pending_generic_cmd = cmd;
        lora_generic_cmd_ready = 1;
        return 1;
    }

    if (line[0] == 'Q' || line[0] == 'q' || line[0] == 'L' || line[0] == 'l')
    {
        /* Q = 静音（拉长遥测周期），L = 恢复。用于排查上下行抢空口的问题 */
        Lora_Cmd_t cmd;
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;
        if (line[0] == 'Q' || line[0] == 'q') strncpy(cmd.cmd, "quiet", sizeof(cmd.cmd) - 1);
        else strncpy(cmd.cmd, "loud", sizeof(cmd.cmd) - 1);

        lora_pending_generic_cmd = cmd;
        lora_generic_cmd_ready = 1;
        return 1;
    }

    if (line[0] == 'P' || line[0] == 'p')
    {
        p = (char *)line + 1;
        comma = strchr(p, ',');
        if (!comma) return 0;

        Lora_PidCmd_t cmd;
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;

        cmd.hkp = (float)strtol(p, NULL, 10) / 1000.0f;
        p = comma + 1;
        comma = strchr(p, ',');
        if (!comma) return 0;
        cmd.hki = (float)strtol(p, NULL, 10) / 1000.0f;
        cmd.hkd = (float)strtol(comma + 1, NULL, 10) / 1000.0f;

        /* 紧凑格式只管航向三项。横向增益必须显式设为 -1（= 不修改），
         * 否则 memset 出来的 0 会被 Navigation_SetPid 当作"设为 0"，
         * 把横偏环的 ki/kd 清掉。 */
        cmd.xkp = -1.0f;
        cmd.xki = -1.0f;
        cmd.xkd = -1.0f;

        lora_pending_pid_cmd = cmd;
        lora_pid_cmd_ready = 1;
        return 1;
    }

    return 0;
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

    /* 先试紧凑文本格式 */
    if (Lora_ParseCompact(line)) return;

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
        /* 缺省 -1 = 保持当前死区值，避免只改缩放时把死区清掉 */
        cmd.ldz = (int16_t)Lora_ExtractInt(line, "ldz", -1);
        cmd.rdz = (int16_t)Lora_ExtractInt(line, "rdz", -1);
        /* 推进电机方向翻转：0 = 保持当前值 */
        cmd.dir = (int8_t)Lora_ExtractInt(line, "dir", 0);
        lora_pending_motorcal_cmd = cmd;
        lora_motorcal_cmd_ready = 1;
    }
    else if (strcmp(type, "hdg") == 0)
    {
        Lora_HeadingCmd_t cmd;
        memset(&cmd, 0, sizeof(cmd));
        cmd.valid = 1;
        cmd.query = (uint8_t)(Lora_ExtractInt(line, "q", 0) != 0);
        cmd.deg   = Lora_ExtractFloat(line, "deg", 0.0f);
        cmd.spd   = (int16_t)Lora_ExtractInt(line, "spd", 0);
        lora_pending_heading_cmd = cmd;
        lora_heading_cmd_ready = 1;
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

        /* IMU 偏航角方向。0 = 本次不提供（保持当前值）。
         * 不同模块的 yaw 可能顺时针增大或逆时针增大，方向反了船会掉头；
         * 做成运行时可调，水上发现不对可以立刻改，不用捞船重烧。 */
        cmd.ys = (int8_t)Lora_ExtractInt(line, "ys", 0);
        /* IMU 安装偏置。用 -999 作为"未提供"哨兵（合法的偏置是 -180~180） */
        cmd.yawos = Lora_ExtractFloat(line, "yawos", -999.0f);

        lora_pending_pid_cmd = cmd;
        lora_pid_cmd_ready = 1;
    }
}

void Lora_ProcessByte(uint8_t byte)
{
    lora_rx_bytes++;

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

uint8_t Lora_GetPendingHeadingCmd(Lora_HeadingCmd_t *cmd)
{
    if (!lora_heading_cmd_ready) return 0;
    *cmd = lora_pending_heading_cmd;
    lora_heading_cmd_ready = 0;
    return 1;
}
