#ifndef __LORA_H__
#define __LORA_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"
#include <stdarg.h>

/**
 * @brief  Lora模块初始化
 * @note   初始化Lora模块，配置USART3串口参数（波特率115200，8位数据位，1位停止位，无校验）
 *         该函数需在main函数中调用，在所有Lora发送函数之前执行
 * @param  无
 * @retval 无
 * @example
 *         Lora_Init();  // 系统初始化时调用
 */
void Lora_Init(void);

/**
 * @brief  通过Lora发送字符串
 * @note   将字符串通过USART3发送出去，自动计算字符串长度
 *         发送超时时间为100ms
 * @param  str: 要发送的字符串指针，以'\0'结尾
 * @retval 无
 * @example
 *         Lora_SendString("Hello World\r\n");
 *         Lora_SendString("Temperature: 25.5\r\n");
 */
void Lora_SendString(const char *str);

/**
 * @brief  通过Lora发送字节数组
 * @note   发送指定长度的原始字节数据，适用于发送二进制数据
 *         发送超时时间为100ms
 * @param  data: 要发送的字节数组指针
 * @param  len:  要发送的数据长度（字节数）
 * @retval 无
 * @example
 *         uint8_t data[] = {0x55, 0xAA, 0x01, 0x02};
 *         Lora_SendBytes(data, 4);
 */
void Lora_SendBytes(uint8_t *data, uint16_t len);

/**
 * @brief  通过Lora发送格式化字符串（类似printf）
 * @note   支持格式化输出，使用方式与标准printf相同
 *         内部使用256字节缓冲区，注意格式化后的字符串不要超过255字节
 * @param  fmt:  格式化字符串，支持%d、%f、%s等标准格式
 * @param  ...:  可变参数列表，要格式化的数据
 * @retval 无
 * @example
 *         Lora_Printf("Temperature: %.1f C\r\n", temp);
 *         Lora_Printf("X=%d, Y=%d, Z=%d\r\n", x, y, z);
 *         Lora_Printf("Status: %s\r\n", status ? "OK" : "ERROR");
 */
void Lora_Printf(const char *fmt, ...);

/**
 * @brief  通过Lora发送带标签的整数
 * @note   自动格式化输出为 "标签: 值\r\n" 格式
 * @param  label: 数据标签字符串，如"Temperature"、"Count"
 * @param  value: 要发送的32位有符号整数
 * @retval 无
 * @example
 *         Lora_SendInt("Temperature", 25);
 *         Lora_SendInt("ADC_Value", adc_result);
 *         // 输出: Temperature: 25\r\n
 */
void Lora_SendInt(const char *label, int32_t value);

/**
 * @brief  通过Lora发送带标签的浮点数
 * @note   自动格式化输出为 "标签: 值\r\n" 格式，可指定小数位数
 * @param  label:    数据标签字符串，如"Voltage"、"Current"
 * @param  value:    要发送的浮点数值
 * @param  decimals: 小数位数，范围0-9，如1表示保留1位小数
 * @retval 无
 * @example
 *         Lora_SendFloat("Voltage", 3.14159f, 2);   // 输出: Voltage: 3.14\r\n
 *         Lora_SendFloat("Current", 0.1234f, 3);    // 输出: Current: 0.123\r\n
 *         Lora_SendFloat("PH", 7.5f, 1);            // 输出: PH: 7.5\r\n
 */
void Lora_SendFloat(const char *label, float value, uint8_t decimals);

/**
 * @brief  通过Lora发送换行符
 * @note   发送"\r\n"回车换行，用于格式化输出时换行
 * @param  无
 * @retval 无
 * @example
 *         Lora_Printf("Line 1");
 *         Lora_SendNewLine();
 *         Lora_Printf("Line 2");
 */
void Lora_SendNewLine(void);

/* --- LoRa 下行命令接收 --- */

/** 收到的 target 命令结构 */
typedef struct {
    uint8_t  valid;          /* 1 = 有待处理的 target 命令 */
    char     zone[16];       /* 区域 ID 字符串 */
    int32_t  lat;            /* 纬度 * 1e7 */
    int32_t  lon;            /* 经度 * 1e7 */
    int32_t  r;              /* 保持/兜底半径 m，兼容旧协议 */
    int32_t  ar;             /* 到达半径 m */
    int32_t  rr;             /* 漂移/归位触发半径 m */
    int32_t  bm;             /* 边界容差 m */
    int32_t  bclat;          /* 区域中心纬度 * 1e7 */
    int32_t  bclon;          /* 区域中心经度 * 1e7 */
    float    blen;           /* 区域南北长度 m */
    float    bwid;           /* 区域东西宽度 m */
} Lora_TargetCmd_t;

/** 收到的 cmd 命令结构 */
typedef struct {
    uint8_t  valid;
    char     cmd[16];        /* "start" / "stop" / "sensor" */
} Lora_Cmd_t;

/** 收到的 motor 命令结构 */
typedef struct {
    uint8_t  valid;
    int32_t  l;              /* 左电机速度 */
    int32_t  r;              /* 右电机速度 */
} Lora_MotorCmd_t;

/** 收到的 mcal（电机校准）命令结构 */
typedef struct {
    uint8_t  valid;
    float    ls;             /* left_scale */
    float    rs;             /* right_scale */
    int16_t  lo;             /* left_offset */
    int16_t  ro;             /* right_offset */
    int16_t  ldz;            /* left_deadzone，负数 = 保持当前值 */
    int16_t  rdz;            /* right_deadzone，负数 = 保持当前值 */
} Lora_MotorCalCmd_t;

/**
 * @brief 运行时下发 PID 增益（双层：内环航向 + 外环横向）
 * @note  下位机格式：
 *        {"t":"pid","hkp":2.0,"hki":0.35,"hkd":0.25,
 *                   "xkp":2.3,"xki":0.30,"xkd":0.12}
 *        省去的字段保持原值不变，方便只改一项。
 */
typedef struct {
    uint8_t  valid;
    float    hkp, hki, hkd;  /* 内环：航向误差 -> 转向输出 */
    float    xkp, xki, xkd;  /* 外环：横向偏差 -> 目标航向修正 */
    int8_t   ys;             /* IMU 偏航角方向：0=保持不变，+1/-1=设置 */
} Lora_PidCmd_t;

/**
 * @brief  启动 LoRa USART3 中断接收（单字节）
 * @note   在 Lora_Init() 之后、主循环之前调用一次
 */
/** 累计收到的字节数（诊断用：判断下行数据是否真的到达了 MCU） */
extern volatile uint32_t lora_rx_bytes;

void Lora_StartReceive(void);

/**
 * @brief  处理一个从 USART3 中断收到的字节
 * @note   由 HAL_UART_RxCpltCallback 调用，内部按 \n 拆行并解析 JSON
 * @param  byte: 收到的字节
 */
void Lora_ProcessByte(uint8_t byte);

/**
 * @brief  检查是否有待处理的 target 命令
 * @retval 1 = 有，0 = 无
 */
uint8_t Lora_HasPendingCommand(void);

/**
 * @brief  取出待处理的 target 命令并清除标志
 * @param  cmd: 输出结构体指针
 * @retval 1 = 成功取出，0 = 没有命令
 */
uint8_t Lora_GetPendingCommand(Lora_TargetCmd_t *cmd);

/**
 * @brief  检查是否有待处理的 cmd 命令
 * @retval 1 = 有，0 = 无
 */
uint8_t Lora_HasPendingCmd(void);

/**
 * @brief  取出待处理的 cmd 命令并清除标志
 * @param  cmd: 输出结构体指针
 * @retval 1 = 成功取出，0 = 没有命令
 */
uint8_t Lora_GetPendingCmd(Lora_Cmd_t *cmd);

/**
 * @brief  检查是否有待处理的 motor 命令
 * @retval 1 = 有，0 = 无
 */
uint8_t Lora_HasPendingMotorCmd(void);

/**
 * @brief  取出待处理的 motor 命令并清除标志
 * @param  cmd: 输出结构体指针
 * @retval 1 = 成功取出，0 = 没有命令
 */
uint8_t Lora_GetPendingMotorCmd(Lora_MotorCmd_t *cmd);

/**
 * @brief  检查是否有待处理的 mcal 命令
 * @retval 1 = 有，0 = 无
 */
uint8_t Lora_HasPendingMotorCalCmd(void);

/** 检查是否有待处理的 pid 命令 */
uint8_t Lora_HasPendingPidCmd(void);

/** 取出待处理的 pid 命令并清除标志 */
uint8_t Lora_GetPendingPidCmd(Lora_PidCmd_t *cmd);

/**
 * @brief  取出待处理的 mcal 命令并清除标志
 * @param  cmd: 输出结构体指针
 * @retval 1 = 成功取出，0 = 没有命令
 */
uint8_t Lora_GetPendingMotorCalCmd(Lora_MotorCalCmd_t *cmd);

#ifdef __cplusplus
}
#endif

#endif
