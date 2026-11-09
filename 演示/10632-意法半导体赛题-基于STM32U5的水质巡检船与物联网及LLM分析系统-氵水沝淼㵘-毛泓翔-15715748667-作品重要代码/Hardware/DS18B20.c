#include "main.h"
#include "DS18B20.h"


static void DS18B20_DelayUs(uint32_t us)
{
    uint32_t start = DWT->CYCCNT;
    uint32_t cycles = us * (SystemCoreClock / 1000000);
    while ((DWT->CYCCNT - start) < cycles);
}

static void DS18B20_SetPinOutput(void)
{
    GPIO_InitTypeDef GPIO_InitStruct = {0};
    GPIO_InitStruct.Pin = DS18B20_PIN;
    GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(DS18B20_PORT, &GPIO_InitStruct);
}

static void DS18B20_SetPinInput(void)
{
    GPIO_InitTypeDef GPIO_InitStruct = {0};
    GPIO_InitStruct.Pin = DS18B20_PIN;
    GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
    GPIO_InitStruct.Pull = GPIO_PULLUP;
    HAL_GPIO_Init(DS18B20_PORT, &GPIO_InitStruct);
}

static void DS18B20_WritePin(GPIO_PinState state)
{
    HAL_GPIO_WritePin(DS18B20_PORT, DS18B20_PIN, state);
}

static GPIO_PinState DS18B20_ReadPin(void)
{
    return HAL_GPIO_ReadPin(DS18B20_PORT, DS18B20_PIN);
}

void DS18B20_Init(void)
{
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CYCCNT = 0;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
    
    DS18B20_SetPinOutput();
    DS18B20_WritePin(GPIO_PIN_SET);
}

uint8_t DS18B20_Reset(void)
{
    uint8_t presence = 0;
    
    DS18B20_SetPinOutput();
    DS18B20_WritePin(GPIO_PIN_RESET);
    DS18B20_DelayUs(480);
    
    DS18B20_SetPinInput();
    DS18B20_DelayUs(70);
    
    if (DS18B20_ReadPin() == GPIO_PIN_RESET)
    {
        presence = 1;
    }
    
    DS18B20_DelayUs(410);
    
    return presence;
}

void DS18B20_WriteByte(uint8_t data)
{
    DS18B20_SetPinOutput();
    
    for (uint8_t i = 0; i < 8; i++)
    {
        if (data & 0x01)
        {
            DS18B20_WritePin(GPIO_PIN_RESET);
            DS18B20_DelayUs(6);
            DS18B20_WritePin(GPIO_PIN_SET);
            DS18B20_DelayUs(64);
        }
        else
        {
            DS18B20_WritePin(GPIO_PIN_RESET);
            DS18B20_DelayUs(60);
            DS18B20_WritePin(GPIO_PIN_SET);
            DS18B20_DelayUs(10);
        }
        data >>= 1;
    }
}

uint8_t DS18B20_ReadByte(void)
{
    uint8_t data = 0;
    
    for (uint8_t i = 0; i < 8; i++)
    {
        DS18B20_SetPinOutput();
        DS18B20_WritePin(GPIO_PIN_RESET);
        DS18B20_DelayUs(6);
        
        DS18B20_SetPinInput();
        DS18B20_DelayUs(9);
        
        if (DS18B20_ReadPin() == GPIO_PIN_SET)
        {
            data |= (0x01 << i);
        }
        
        DS18B20_DelayUs(55);
    }
    
    return data;
}

float DS18B20_GetTemp(void)
{
    uint8_t tempL, tempH;
    int16_t temp;
    float temperature;
    uint32_t timeout;

    if (!DS18B20_Reset())
    {
        return -1000.0f;
    }

    DS18B20_WriteByte(0xCC);
    DS18B20_WriteByte(0x44);

    // 等待转换完成：DS18B20 在转换期间返回 0，完成后返回 1
    timeout = 1000; // 最多等约 1 秒
    while (timeout > 0)
    {
        DS18B20_SetPinOutput();
        DS18B20_WritePin(GPIO_PIN_RESET);
        DS18B20_DelayUs(6);
        DS18B20_SetPinInput();
        DS18B20_DelayUs(9);

        if (DS18B20_ReadPin() == GPIO_PIN_SET)
        {
            DS18B20_DelayUs(55);
            break; // 转换完成
        }

        DS18B20_DelayUs(55);
        HAL_Delay(1);
        timeout--;
    }

    if (timeout == 0)
    {
        return -1000.0f; // 转换超时
    }

    if (!DS18B20_Reset())
    {
        return -1000.0f;
    }

    DS18B20_WriteByte(0xCC);
    DS18B20_WriteByte(0xBE);

    tempL = DS18B20_ReadByte();
    tempH = DS18B20_ReadByte();

    temp = (tempH << 8) | tempL;

    // 检查是否是默认值 0x0550 (85°C)
    if (temp == 0x0550)
    {
        return -1000.0f; // 未完成转换，返回错误
    }

    temperature = (float)temp / 16.0f;

    return temperature;
}

float DS18B20_GetTempMultiple(uint8_t samples)
{
    float sum = 0.0f;
    uint8_t validCount = 0;
    
    for (uint8_t i = 0; i < samples; i++)
    {
        float temp = DS18B20_GetTemp();
        if (temp > -100.0f)
        {
            sum += temp;
            validCount++;
        }
        HAL_Delay(100);
    }
    
    if (validCount == 0)
    {
        return -1000.0f;
    }
    
    return sum / (float)validCount;
}
