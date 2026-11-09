#include "IMU901.h"
#include "usart.h"

extern UART_HandleTypeDef huart2;

attitude_t     attitude;
quaternion_t   quaternion;
gyroAcc_t      gyroAccData;
mag_t          magData;
baro_t         baroData;
ioStatus_t     iostatus;
regValue_t     imu901Param;
atkp_t         rxPacket;
volatile uint32_t imu901_rx_count = 0;
volatile uint32_t imu901_packet_count = 0;
volatile uint32_t imu901_attitude_count = 0;
volatile uint32_t imu901_last_update_ms = 0;

const uint16_t gyroFsrTable[4] = {250, 500, 1000, 2000};
const uint8_t  accFsrTable[4] = {2, 4, 8, 16};

static enum
{
    waitForStartByte1,
    waitForStartByte2,
    waitForMsgID,
    waitForDataLength,
    waitForData,
    waitForChksum1,
} rxState = waitForStartByte1;

uint8_t imu901_unpack(uint8_t ch)
{
    static uint8_t cksum = 0, dataIndex = 0;

    switch (rxState)
    {
        case waitForStartByte1:
            if (ch == UP_BYTE1)
            {
                rxState = waitForStartByte2;
                rxPacket.startByte1 = ch;
            }
            cksum = ch;
            break;

        case waitForStartByte2:
            if (ch == UP_BYTE2 || ch == UP_BYTE2_ACK)
            {
                rxState = waitForMsgID;
                rxPacket.startByte2 = ch;
            }
            else
            {
                rxState = waitForStartByte1;
            }
            cksum += ch;
            break;

        case waitForMsgID:
            rxPacket.msgID = ch;
            rxState = waitForDataLength;
            cksum += ch;
            break;

        case waitForDataLength:
            if (ch <= ATKP_MAX_DATA_SIZE)
            {
                rxPacket.dataLen = ch;
                dataIndex = 0;
                rxState = (ch > 0) ? waitForData : waitForChksum1;
                cksum += ch;
            }
            else
            {
                rxState = waitForStartByte1;
            }
            break;

        case waitForData:
            rxPacket.data[dataIndex] = ch;
            dataIndex++;
            cksum += ch;
            if (dataIndex == rxPacket.dataLen)
            {
                rxState = waitForChksum1;
            }
            break;

        case waitForChksum1:
            if (cksum == ch)
            {
                rxPacket.checkSum = cksum;
                rxState = waitForStartByte1;
                return 1;
            }
            else
            {
                rxState = waitForStartByte1;
            }
            break;

        default:
            rxState = waitForStartByte1;
            break;
    }

    return 0;
}

void atkpParsing(atkp_t *packet)
{
    imu901_packet_count++;

    if (packet->msgID == UP_ATTITUDE)
    {
        int16_t data = (int16_t)((packet->data[1] << 8) | packet->data[0]);
        attitude.roll = (float)data / 32768 * 180;

        data = (int16_t)((packet->data[3] << 8) | packet->data[2]);
        attitude.pitch = (float)data / 32768 * 180;

        data = (int16_t)((packet->data[5] << 8) | packet->data[4]);
        attitude.yaw = (float)data / 32768 * 180;

        imu901_attitude_count++;
        imu901_last_update_ms = HAL_GetTick();
    }
    else if (packet->msgID == UP_QUAT)
    {
        int16_t data = (int16_t)((packet->data[1] << 8) | packet->data[0]);
        quaternion.q0 = (float)data / 32768;

        data = (int16_t)((packet->data[3] << 8) | packet->data[2]);
        quaternion.q1 = (float)data / 32768;

        data = (int16_t)((packet->data[5] << 8) | packet->data[4]);
        quaternion.q2 = (float)data / 32768;

        data = (int16_t)((packet->data[7] << 8) | packet->data[6]);
        quaternion.q3 = (float)data / 32768;
    }
    else if (packet->msgID == UP_GYROACCDATA)
    {
        gyroAccData.acc[0] = (int16_t)((packet->data[1] << 8) | packet->data[0]);
        gyroAccData.acc[1] = (int16_t)((packet->data[3] << 8) | packet->data[2]);
        gyroAccData.acc[2] = (int16_t)((packet->data[5] << 8) | packet->data[4]);

        gyroAccData.gyro[0] = (int16_t)((packet->data[7] << 8) | packet->data[6]);
        gyroAccData.gyro[1] = (int16_t)((packet->data[9] << 8) | packet->data[8]);
        gyroAccData.gyro[2] = (int16_t)((packet->data[11] << 8) | packet->data[10]);

        gyroAccData.faccG[0] = (float)gyroAccData.acc[0] / 32768 * accFsrTable[imu901Param.accFsr];
        gyroAccData.faccG[1] = (float)gyroAccData.acc[1] / 32768 * accFsrTable[imu901Param.accFsr];
        gyroAccData.faccG[2] = (float)gyroAccData.acc[2] / 32768 * accFsrTable[imu901Param.accFsr];

        gyroAccData.fgyroD[0] = (float)gyroAccData.gyro[0] / 32768 * gyroFsrTable[imu901Param.gyroFsr];
        gyroAccData.fgyroD[1] = (float)gyroAccData.gyro[1] / 32768 * gyroFsrTable[imu901Param.gyroFsr];
        gyroAccData.fgyroD[2] = (float)gyroAccData.gyro[2] / 32768 * gyroFsrTable[imu901Param.gyroFsr];
    }
    else if (packet->msgID == UP_MAGDATA)
    {
        magData.mag[0] = (int16_t)((packet->data[1] << 8) | packet->data[0]);
        magData.mag[1] = (int16_t)((packet->data[3] << 8) | packet->data[2]);
        magData.mag[2] = (int16_t)((packet->data[5] << 8) | packet->data[4]);

        int16_t data = (int16_t)((packet->data[7] << 8) | packet->data[6]);
        magData.temp = (float)data / 100;
    }
    else if (packet->msgID == UP_BARODATA)
    {
        baroData.pressure = (int32_t)((packet->data[3] << 24) | (packet->data[2] << 16) |
                            (packet->data[1] << 8) | packet->data[0]);
        baroData.altitude = (int32_t)((packet->data[7] << 24) | (packet->data[6] << 16) |
                            (packet->data[5] << 8) | packet->data[4]);

        int16_t data = (int16_t)((packet->data[9] << 8) | packet->data[8]);
        baroData.temp = (float)data / 100;
    }
    else if (packet->msgID == UP_D03DATA)
    {
        iostatus.d03data[0] = (uint16_t)((packet->data[1] << 8) | packet->data[0]);
        iostatus.d03data[1] = (uint16_t)((packet->data[3] << 8) | packet->data[2]);
        iostatus.d03data[2] = (uint16_t)((packet->data[5] << 8) | packet->data[4]);
        iostatus.d03data[3] = (uint16_t)((packet->data[7] << 8) | packet->data[6]);
    }
}

void atkpWriteReg(enum regTable reg, uint16_t data, uint8_t datalen)
{
    uint8_t buf[7];

    buf[0] = 0x55;
    buf[1] = 0xAF;
    buf[2] = reg;
    buf[3] = datalen;
    buf[4] = data;

    if (datalen == 2)
    {
        buf[5] = data >> 8;
        buf[6] = buf[0] + buf[1] + buf[2] + buf[3] + buf[4] + buf[5];
        HAL_UART_Transmit(&huart2, buf, 7, 100);
    }
    else
    {
        buf[5] = buf[0] + buf[1] + buf[2] + buf[3] + buf[4];
        HAL_UART_Transmit(&huart2, buf, 6, 100);
    }
}

void IMU901_Init(void)
{
    atkpWriteReg(REG_GYROFSR, 3, 1);
    atkpWriteReg(REG_ACCFSR, 1, 1);
    atkpWriteReg(REG_SAVE, 0, 1);

    imu901Param.gyroFsr = 3;
    imu901Param.accFsr = 1;
    imu901Param.gyroBW = 0;
    imu901Param.accBW = 0;

    IMU901_StartReceive();
}

float IMU901_GetRoll(void)
{
    return attitude.roll;
}

float IMU901_GetPitch(void)
{
    return attitude.pitch;
}

float IMU901_GetYaw(void)
{
    return attitude.yaw;
}
