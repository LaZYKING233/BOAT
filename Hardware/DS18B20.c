#include "main.h"
#include "DS18B20.h"

/* ============================================================
 * DS18B20 单总线驱动（非阻塞版）
 *
 * 原实现每次读温度都在主循环里轮询 750ms 等转换完成，直接把
 * Navigation_Update() 的 50ms 周期拖成 ~1.2Hz，航向 PID 无法工作。
 * 现改为状态机：主循环调用 DS18B20_Update() 推进，GetTemp() 只取缓存。
 * ============================================================ */

static float    s_temp_c      = -1000.0f;
static uint8_t  s_temp_valid  = 0U;
static uint8_t  s_conv_busy   = 0U;
static uint32_t s_conv_start  = 0U;
static uint32_t s_last_start  = 0U;

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

    s_temp_c     = -1000.0f;
    s_temp_valid = 0U;
    s_conv_busy  = 0U;
    s_conv_start = 0U;
    /* 让第一圈就启动转换：首次读数在 ~800ms 后到达，而不是 1.8s */
    s_last_start = HAL_GetTick() - DS18B20_PERIOD_MS;
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

static void DS18B20_BeginConversion(void)
{
    if (!DS18B20_Reset())
    {
        s_temp_valid = 0U;
        return;
    }

    DS18B20_WriteByte(0xCC);   /* Skip ROM：总线上只有一个器件 */
    DS18B20_WriteByte(0x44);   /* Convert T */

    s_conv_busy  = 1U;
    s_conv_start = HAL_GetTick();
}

static void DS18B20_ReadScratchpad(void)
{
    uint8_t t_lsb = 0;
    uint8_t t_msb = 0;
    int16_t raw;

    if (!DS18B20_Reset())
    {
        s_temp_valid = 0U;
        return;
    }

    /* 位时序窗口只有几十微秒，期间被 UART 中断打断会读错
       （这正是原来"85°C"假值的来源）。临界区约 2ms，每秒一次。 */
    __disable_irq();
    DS18B20_WriteByte(0xCC);   /* Skip ROM */
    DS18B20_WriteByte(0xBE);   /* Read Scratchpad */
    t_lsb = DS18B20_ReadByte();
    t_msb = DS18B20_ReadByte();
    __enable_irq();

    raw = (int16_t)(((uint16_t)t_msb << 8) | t_lsb);

    /* 上电默认值 0x0550 = 85℃：说明转换没完成或器件没应答 */
    if (raw == 0x0550)
    {
        s_temp_valid = 0U;
        return;
    }

    s_temp_c = (float)raw / 16.0f;
    s_temp_valid = (s_temp_c > -55.0f && s_temp_c < 125.0f) ? 1U : 0U;
}

void DS18B20_Update(void)
{
    uint32_t now = HAL_GetTick();

    if (s_conv_busy)
    {
        if ((now - s_conv_start) >= DS18B20_CONV_MS)
        {
            s_conv_busy = 0U;
            DS18B20_ReadScratchpad();
        }
        return;
    }

    if ((now - s_last_start) >= DS18B20_PERIOD_MS)
    {
        s_last_start = now;
        DS18B20_BeginConversion();
    }
}

float DS18B20_GetTemp(void)
{
    return s_temp_valid ? s_temp_c : -1000.0f;
}

uint8_t DS18B20_IsValid(void)
{
    return s_temp_valid;
}
