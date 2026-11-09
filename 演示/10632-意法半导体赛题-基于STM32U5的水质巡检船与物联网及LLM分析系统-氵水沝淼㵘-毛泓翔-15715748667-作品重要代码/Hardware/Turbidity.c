#include "main.h"
#include "Turbidity.h"
#include "adc.h"

extern ADC_HandleTypeDef hadc1;

void Turbidity_Init(void)
{
    HAL_ADCEx_Calibration_Start(&hadc1, ADC_CALIB_OFFSET, ADC_SINGLE_ENDED);
}

float Turbidity_ReadVoltage(void)
{
    ADC_ChannelConfTypeDef sConfig = {0};
    sConfig.Channel = TURBIDITY_ADC_CHANNEL;
    sConfig.Rank = ADC_REGULAR_RANK_1;
    sConfig.SamplingTime = ADC_SAMPLETIME_391CYCLES;
    sConfig.SingleDiff = ADC_SINGLE_ENDED;
    
    HAL_ADC_ConfigChannel(&hadc1, &sConfig);
    
    HAL_ADC_Start(&hadc1);
    HAL_ADC_PollForConversion(&hadc1, 100);
    uint32_t adcValue = HAL_ADC_GetValue(&hadc1);
    HAL_ADC_Stop(&hadc1);
    
    float voltage = (float)adcValue * TURBIDITY_VREF / TURBIDITY_ADC_RESOLUTION;
    
    float actualVoltage = voltage / TURBIDITY_VOLTAGE_DIVIDER_RATIO;
    
    return actualVoltage;
}

float Turbidity_ReadNTU(void)
{
    float voltage = Turbidity_ReadVoltage();
    
    float ntu = -1120.4f * voltage * voltage + 5742.3f * voltage - 4352.9f;
    
    if (ntu < 0.0f) ntu = 0.0f;
    if (ntu > 3000.0f) ntu = 3000.0f;
    
    return ntu;
}

uint8_t Turbidity_IsHigh(void)
{
    return (HAL_GPIO_ReadPin(TURBIDITY_DIGITAL_PORT, TURBIDITY_DIGITAL_PIN) == GPIO_PIN_RESET);
}

float Turbidity_GetAverageNTU(uint8_t samples)
{
    float sum = 0.0f;
    
    for (uint8_t i = 0; i < samples; i++)
    {
        sum += Turbidity_ReadNTU();
        HAL_Delay(10);
    }
    
    return sum / (float)samples;
}
