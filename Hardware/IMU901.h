#ifndef __IMU901_H__
#define __IMU901_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"

#define UP_BYTE1        0x55
#define UP_BYTE2        0x55
#define UP_BYTE2_ACK    0xAF

enum upmsgid
{
    UP_ATTITUDE     = 0x01,
    UP_QUAT         = 0x02,
    UP_GYROACCDATA  = 0x03,
    UP_MAGDATA      = 0x04,
    UP_BARODATA     = 0x05,
    UP_D03DATA      = 0x06,
};

enum regTable
{
    REG_SAVE    = 0x00,
    REG_SENCAL  = 0x01,
    REG_SENSTA  = 0x02,
    REG_GYROFSR = 0x03,
    REG_ACCFSR  = 0x04,
    REG_GYROBW  = 0x05,
    REG_ACCBW   = 0x06,
    REG_BAUD    = 0x07,
    REG_UPSET   = 0x08,
    REG_UPSET2  = 0x09,
    REG_UPRATE  = 0x0A,
    REG_ALG     = 0x0B,
    REG_ASM     = 0x0C,
    REG_GACOFF  = 0x0D,
    REG_BACOFF  = 0x0E,
    REG_LEDOFF  = 0x0F,
    REG_D0MODE  = 0x10,
    REG_D1MODE  = 0x11,
    REG_D2MODE  = 0x12,
    REG_D3MODE  = 0x13,
    REG_D0PULSE = 0x14,
    REG_D1PULSE = 0x16,
    REG_D2PULSE = 0x18,
    REG_D3PULSE = 0x1A,
    REG_D0PERIOD = 0x1C,
    REG_D1PERIOD = 0x1F,
    REG_D2PERIOD = 0x21,
    REG_D3PERIOD = 0x23,
    REG_RESET   = 0x7F,
};

#define ATKP_MAX_DATA_SIZE 28

typedef struct
{
    uint8_t startByte1;
    uint8_t startByte2;
    uint8_t msgID;
    uint8_t dataLen;
    uint8_t data[ATKP_MAX_DATA_SIZE];
    uint8_t checkSum;
} atkp_t;

typedef struct
{
    float roll;
    float pitch;
    float yaw;
} attitude_t;

typedef struct
{
    float q0, q1, q2, q3;
} quaternion_t;

typedef struct
{
    int16_t gyro[3];
    int16_t acc[3];
    float   fgyroD[3];
    float   faccG[3];
} gyroAcc_t;

typedef struct
{
    int16_t mag[3];
    float   temp;
} mag_t;

typedef struct
{
    int32_t pressure;
    int32_t altitude;
    float   temp;
} baro_t;

typedef struct
{
    uint16_t d03data[4];
} ioStatus_t;

typedef struct
{
    uint8_t gyroFsr;
    uint8_t accFsr;
    uint8_t gyroBW;
    uint8_t accBW;
} regValue_t;

extern attitude_t     attitude;
extern quaternion_t   quaternion;
extern gyroAcc_t      gyroAccData;
extern mag_t          magData;
extern baro_t         baroData;
extern ioStatus_t     iostatus;
extern regValue_t     imu901Param;
extern atkp_t         rxPacket;
extern volatile uint32_t imu901_rx_count;
extern volatile uint32_t imu901_packet_count;
extern volatile uint32_t imu901_attitude_count;
extern volatile uint32_t imu901_last_update_ms;

/**
 * @brief  IMU901陀螺仪模块初始化
 * @note   初始化IMU901模块，配置陀螺仪和加速度计量程，并启动串口中断接收
 *         - 陀螺仪量程设置为2000 deg/s
 *         - 加速度计量程设置为4G
 *         - 配置完成后保存到模块内部Flash
 *         - 启动USART2中断接收（波特率115200）
 * @param  无
 * @retval 无
 * @example
 *         IMU901_Init();  // 在main函数初始化阶段调用
 */
void IMU901_Init(void);
void IMU901_StartReceive(void);

/**
 * @brief  IMU901数据帧解析函数（状态机）
 * @note   解析ATKP协议数据帧，需在串口接收中断中逐字节调用
 *         内部使用状态机处理：帧头(0x55 0x55) -> 消息ID -> 数据长度 -> 数据 -> 校验和
 *         当一帧数据完整接收并校验通过后返回1
 * @param  ch: 从串口接收到的单个字节数据
 * @retval uint8_t: 0-数据帧未完整接收或校验失败；1-成功解析一帧完整数据
 * @example
 *         // 在USART2中断回调函数中使用：
 *         void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
 *         {
 *             if(huart->Instance == USART2)
 *             {
 *                 if(imu901_unpack(rx_byte))  // 逐字节解析
 *                 {
 *                     atkpParsing(&rxPacket);  // 解析成功，处理数据
 *                 }
 *             }
 *         }
 */
uint8_t imu901_unpack(uint8_t ch);

/**
 * @brief  ATKP数据包内容解析
 * @note   根据消息ID解析数据包内容，将原始数据转换为实际物理量
 *         解析后的数据存入全局结构体：attitude、gyroAccData、magData、baroData等
 *         支持的解析类型：
 *         - UP_ATTITUDE(0x01): 姿态角（Roll/Pitch/Yaw），单位：度
 *         - UP_QUAT(0x02): 四元数
 *         - UP_GYROACCDATA(0x03): 陀螺仪+加速度原始数据和转换后的物理量
 *         - UP_MAGDATA(0x04): 地磁数据和温度
 *         - UP_BARODATA(0x05): 气压、高度和温度
 *         - UP_D03DATA(0x06): IO口状态
 * @param  packet: 指向已解析完成的atkp_t数据包结构体
 * @retval 无
 * @example
 *         if(imu901_unpack(rx_byte))
 *         {
 *             atkpParsing(&rxPacket);  // 解析数据内容到全局变量
 *             // 之后可直接使用 attitude.roll, gyroAccData.fgyroD[0] 等数据
 *         }
 */
void atkpParsing(atkp_t *packet);

/**
 * @brief  向IMU901模块写入寄存器配置
 * @note   通过串口发送ATKP协议写寄存器命令，用于配置模块参数
 *         写命令帧头为 0x55 0xAF，读命令帧头为 0x55 0x55
 *         配置后需调用 REG_SAVE(0x00) 保存到内部Flash，否则断电丢失
 * @param  reg:     寄存器地址，使用regTable枚举，如REG_GYROFSR、REG_ACCFSR等
 * @param  data:    要写入的寄存器值，范围0-65535
 * @param  datalen: 数据长度，只能为1（单字节）或2（双字节）
 * @retval 无
 * @example
 *         // 设置陀螺仪量程为2000 deg/s
 *         atkpWriteReg(REG_GYROFSR, 3, 1);
 *         
 *         // 设置加速度计量程为4G
 *         atkpWriteReg(REG_ACCFSR, 1, 1);
 *         
 *         // 保存配置到模块内部Flash
 *         atkpWriteReg(REG_SAVE, 0, 1);
 */
void atkpWriteReg(enum regTable reg, uint16_t data, uint8_t datalen);

/**
 * @brief  获取当前Roll角（横滚角）
 * @note   返回最近一次解析到的姿态角Roll值
 *         数据由IMU901模块自动上传，在主循环中直接读取即可
 *         正值：向右倾斜；负值：向左倾斜
 * @param  无
 * @retval float: Roll角，单位：度（-180 ~ +180）
 * @example
 *         float roll = IMU901_GetRoll();
 *         printf("Roll: %.1f deg\r\n", roll);
 */
float IMU901_GetRoll(void);

/**
 * @brief  获取当前Pitch角（俯仰角）
 * @note   返回最近一次解析到的姿态角Pitch值
 *         数据由IMU901模块自动上传，在主循环中直接读取即可
 *         正值：抬头；负值：低头
 * @param  无
 * @retval float: Pitch角，单位：度（-180 ~ +180）
 * @example
 *         float pitch = IMU901_GetPitch();
 *         printf("Pitch: %.1f deg\r\n", pitch);
 */
float IMU901_GetPitch(void);

/**
 * @brief  获取当前Yaw角（偏航角/航向角）
 * @note   返回最近一次解析到的姿态角Yaw值
 *         数据由IMU901模块自动上传，在主循环中直接读取即可
 *         范围：-180 ~ +180度，0度为正北方向
 * @param  无
 * @retval float: Yaw角，单位：度（-180 ~ +180）
 * @example
 *         float yaw = IMU901_GetYaw();
 *         printf("Yaw: %.1f deg\r\n", yaw);
 *         
 *         // 判断航向
 *         if(yaw > -45 && yaw < 45) printf("North\r\n");
 *         else if(yaw >= 45 && yaw < 135) printf("East\r\n");
 *         else if(yaw >= 135 || yaw < -135) printf("South\r\n");
 *         else printf("West\r\n");
 */
float IMU901_GetYaw(void);

#ifdef __cplusplus
}
#endif

#endif
