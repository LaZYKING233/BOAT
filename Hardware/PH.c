#include "main.h"
#include "PH.h"
#include "adc.h"

extern ADC_HandleTypeDef hadc1;

void PH_Init(void)
{
    HAL_ADCEx_Calibration_Start(&hadc1, ADC_CALIB_OFFSET, ADC_SINGLE_ENDED);
}

float PH_ReadVoltage(void)
{
    ADC_ChannelConfTypeDef sConfig = {0};
    sConfig.Channel = PH_ADC_CHANNEL;
    sConfig.Rank = ADC_REGULAR_RANK_1;
    sConfig.SamplingTime = ADC_SAMPLETIME_391CYCLES;
    sConfig.SingleDiff = ADC_SINGLE_ENDED;
    
    HAL_ADC_ConfigChannel(&hadc1, &sConfig);
    
    HAL_ADC_Start(&hadc1);
    HAL_ADC_PollForConversion(&hadc1, 100);
    uint32_t adcValue = HAL_ADC_GetValue(&hadc1);
    HAL_ADC_Stop(&hadc1);
    
    float voltage = (float)adcValue * PH_VREF / PH_ADC_RESOLUTION;
    
    float actualVoltage = voltage / PH_VOLTAGE_DIVIDER_RATIO;
    
    return actualVoltage;
}

float PH_ReadValue(void)
{
    float voltage = PH_ReadVoltage();
    
    float phValue = -5.6342f * voltage + 16.413f;
    
    if (phValue < 0.0f) phValue = 0.0f;
    if (phValue > 14.0f) phValue = 14.0f;
    
    return phValue;
}

float PH_GetAverageValue(uint8_t samples)
{
    float sum = 0.0f;
    
    for (uint8_t i = 0; i < samples; i++)
    {
        sum += PH_ReadValue();
        HAL_Delay(10);
    }
    
    return sum / (float)samples;
}
