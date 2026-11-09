/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main program body
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2026 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "main.h"
#include "adc.h"
#include "icache.h"
#include "tim.h"
#include "usart.h"
#include "gpio.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include <string.h>
#include "Motor.h"
#include "Lora.h"
#include "DS18B20.h"
#include "PH.h"
#include "GPS.h"
#include "IMU901.h"
#include "Navigation.h"
#include "EdgeAI.h"

/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
#define TELEMETRY_ADC_FULL_SCALE        16383U
#define TELEMETRY_ADC_VREF_MV           3300U
#define TELEMETRY_PH_SCALE_NUM          1U
#define TELEMETRY_PH_SCALE_DEN          1U
#define TELEMETRY_PERIOD_MS              1000U
#define NAV_UPDATE_PERIOD_MS             50U
/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/

/* USER CODE BEGIN PV */
static uint32_t last_telemetry_ms = 0;
static uint32_t last_nav_update_ms = 0;
/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
/* USER CODE BEGIN PFP */
static uint32_t Telemetry_ReadAdcRaw(uint32_t channel);
static uint32_t Telemetry_AdcRawToMv(uint32_t raw);
static int32_t Telemetry_ScaleFloat(float value, float scale);
static int32_t Telemetry_CalcPhX100(uint32_t sensor_mv);
static void Telemetry_SendData(void);
/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */
static uint32_t Telemetry_ReadAdcRaw(uint32_t channel)
{
  ADC_ChannelConfTypeDef sConfig = {0};
  uint32_t value = 0;

  HAL_ADC_Stop(&hadc1);

  sConfig.Channel = channel;
  sConfig.Rank = ADC_REGULAR_RANK_1;
  sConfig.SamplingTime = ADC_SAMPLETIME_391CYCLES_5;
  sConfig.SingleDiff = ADC_SINGLE_ENDED;
  sConfig.OffsetNumber = ADC_OFFSET_NONE;
  sConfig.Offset = 0;

  if (HAL_ADC_ConfigChannel(&hadc1, &sConfig) != HAL_OK)
  {
    return 0xFFFFFFFFU;
  }

  if (HAL_ADC_Start(&hadc1) != HAL_OK)
  {
    return 0xFFFFFFFFU;
  }

  if (HAL_ADC_PollForConversion(&hadc1, 20) == HAL_OK)
  {
    value = HAL_ADC_GetValue(&hadc1);
  }
  else
  {
    value = 0xFFFFFFFFU;
  }

  HAL_ADC_Stop(&hadc1);
  return value;
}

static uint32_t Telemetry_AdcRawToMv(uint32_t raw)
{
  return raw * TELEMETRY_ADC_VREF_MV / TELEMETRY_ADC_FULL_SCALE;
}

static int32_t Telemetry_ScaleFloat(float value, float scale)
{
  if (value >= 0.0f)
  {
    return (int32_t)(value * scale + 0.5f);
  }
  return (int32_t)(value * scale - 0.5f);
}

static int32_t Telemetry_CalcPhX100(uint32_t sensor_mv)
{
  float voltage = (float)sensor_mv / 1000.0f;
  float ph = -5.6342f * voltage + 16.413f;

  if (ph < 0.0f) ph = 0.0f;
  if (ph > 14.0f) ph = 14.0f;

  return Telemetry_ScaleFloat(ph, 100.0f);
}

static void Telemetry_SendData(void)
{
  static uint32_t seq = 0;
  uint32_t ph_raw = Telemetry_ReadAdcRaw(PH_ADC_CHANNEL);
  uint32_t ph_adc_mv = (ph_raw == 0xFFFFFFFFU) ? 0U : Telemetry_AdcRawToMv(ph_raw);
  uint32_t ph_sensor_mv = ph_adc_mv * TELEMETRY_PH_SCALE_NUM / TELEMETRY_PH_SCALE_DEN;
  int32_t ph_x100 = (ph_raw == 0xFFFFFFFFU) ? 0 : Telemetry_CalcPhX100(ph_sensor_mv);
  float temp = DS18B20_GetTemp();
  uint8_t temp_valid = (temp > -100.0f) ? 1U : 0U;
  int32_t temp_x100 = temp_valid ? Telemetry_ScaleFloat(temp, 100.0f) : 0;
  uint8_t gps_valid = GPS_IsFixed() ? 1U : 0U;
  int32_t lat_x1e7 = gps_valid ? Telemetry_ScaleFloat(gps_data.latitude, 10000000.0f) : 0;
  int32_t lon_x1e7 = gps_valid ? Telemetry_ScaleFloat(gps_data.longitude, 10000000.0f) : 0;
  uint8_t imu_valid = (imu901_attitude_count > 0U) ? 1U : 0U;
  int32_t imu_roll_x100 = imu_valid ? Telemetry_ScaleFloat(attitude.roll, 100.0f) : 0;
  int32_t imu_pitch_x100 = imu_valid ? Telemetry_ScaleFloat(attitude.pitch, 100.0f) : 0;
  int32_t imu_yaw_x100 = imu_valid ? Telemetry_ScaleFloat(attitude.yaw, 100.0f) : 0;
  EdgeAI_Status_t ai_status;

  EdgeAI_UpdatePh(ph_x100, (ph_raw == 0xFFFFFFFFU) ? 0U : ph_raw, ph_sensor_mv);
  EdgeAI_UpdateTemperature(temp_x100, temp_valid);
  ai_status = EdgeAI_GetStatus();

  Lora_Printf("{\"t\":\"data\",\"v\":1,\"seq\":%lu,\"ms\":%lu,"
              "\"ph\":%ld,\"phr\":%lu,\"phmv\":%lu,"
              "\"tc\":%ld,\"tv\":%u,"
              "\"fix\":%u,\"sat\":%u,\"lat\":%ld,\"lon\":%ld,"
              "\"iv\":%u,\"ir\":%ld,\"ip\":%ld,\"iy\":%ld,\"ib\":%lu,\"ia\":%lu,"
              "\"gb\":%lu,\"gl\":%lu,"
              "\"ns\":%u,\"nd\":%ld,\"nt\":%ld,\"bs\":%u,\"bd\":%ld,\"rs\":%u,\"rd\":%ld,\"xt\":%ld,\"ch\":%ld,"
              "\"to\":%d,\"lw\":%d,\"rw\":%d,"
              "\"hk\":%ld,\"hi\":%ld,\"hd\":%ld,\"xk\":%ld,\"xi\":%ld,\"xd\":%ld,"
              "\"aiph\":%u,\"aiphn\":%u,\"ait\":%u,\"aitn\":%u,"
              "\"mls\":%ld,\"mrs\":%ld,\"mlo\":%ld,\"mro\":%ld,"
              "\"mlz\":%ld,\"mrz\":%ld}\r\n",
              (unsigned long)seq++,
              (unsigned long)HAL_GetTick(),
              (long)ph_x100,
              (unsigned long)((ph_raw == 0xFFFFFFFFU) ? 0U : ph_raw),
              (unsigned long)ph_sensor_mv,
              (long)temp_x100,
              temp_valid,
              gps_data.fix,
              gps_data.satellite_num,
              (long)lat_x1e7,
              (long)lon_x1e7,
              imu_valid,
              (long)imu_roll_x100,
              (long)imu_pitch_x100,
              (long)imu_yaw_x100,
              (unsigned long)imu901_rx_count,
              (unsigned long)imu901_attitude_count,
              (unsigned long)gps_rx_count,
              (unsigned long)gps_sentence_count,
              (unsigned int)nav.state,
              (long)((nav.state != NAV_IDLE) ? (nav.distance * 100.0f) : 0.0f),
              (long)(nav.heading_error * 100.0f),
              (unsigned int)nav.boundary_state,
              (long)(nav.boundary_distance_m * 100.0f),
              (unsigned int)nav.return_state,
              (long)(nav.return_distance_m * 100.0f),
              (long)(nav.cross_track_error_m * 100.0f),
              (long)(nav.corrected_heading * 100.0f),
              (int)nav.turn_output,
              (int)Motor_GetLastPwm(MOTOR_SPEED_LEFT),
              (int)Motor_GetLastPwm(MOTOR_SPEED_RIGHT),
              (long)(heading_pid.kp * 1000.0f),
              (long)(heading_pid.ki * 1000.0f),
              (long)(heading_pid.kd * 1000.0f),
              (long)(crosstrack_pid.kp * 1000.0f),
              (long)(crosstrack_pid.ki * 1000.0f),
              (long)(crosstrack_pid.kd * 1000.0f),
              ai_status.ph_similarity,
              ai_status.ph_normal,
              ai_status.temperature_similarity,
              ai_status.temperature_normal,
              (long)(motor_cal.left_scale * 100.0f),
              (long)(motor_cal.right_scale * 100.0f),
              (long)motor_cal.left_offset,
              (long)motor_cal.right_offset,
              (long)motor_cal.left_deadzone,
              (long)motor_cal.right_deadzone);
}
/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{

  /* USER CODE BEGIN 1 */

  /* USER CODE END 1 */

  /* MCU Configuration--------------------------------------------------------*/

  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* USER CODE BEGIN Init */

  /* USER CODE END Init */

  /* Configure the system clock */
  SystemClock_Config();

  /* USER CODE BEGIN SysInit */

  /* USER CODE END SysInit */

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  MX_ICACHE_Init();
  MX_TIM1_Init();
  MX_ADC1_Init();
  MX_USART2_UART_Init();
  MX_USART3_UART_Init();
  MX_UART4_Init();
  /* USER CODE BEGIN 2 */
  Motor_Init();
  Motor_Stop_All();
  Lora_Init();
  Lora_StartReceive();
  DS18B20_Init();
  PH_Init();
  GPS_Init();
  IMU901_Init();
  Navigation_Init();
  EdgeAI_Init();

  Lora_Printf("{\"t\":\"boot\",\"v\":1,\"ms\":%lu,\"msg\":\"boat telemetry start\",\"phdiv\":100,\"tbdiv\":150}\r\n",
              (unsigned long)HAL_GetTick());
  /* USER CODE END 2 */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  while (1)
  {
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
    /* check LoRa downlink target command */
    {
      Lora_TargetCmd_t cmd;
      if (Lora_GetPendingCommand(&cmd))
      {
        Navigation_SetMissionTarget((float)cmd.lat / 10000000.0f,
                                    (float)cmd.lon / 10000000.0f,
                                    (float)cmd.ar,
                                    (float)cmd.r,
                                    (float)cmd.rr,
                                    (float)cmd.bclat / 10000000.0f,
                                    (float)cmd.bclon / 10000000.0f,
                                    cmd.blen,
                                    cmd.bwid,
                                    (float)cmd.bm);
        Navigation_Start();
        Lora_Printf("{\"t\":\"ack\",\"kind\":\"target\",\"zone\":\"%s\",\"lat\":%ld,\"lon\":%ld,\"r\":%ld,\"ar\":%ld,\"rr\":%ld,\"bm\":%ld}\r\n",
                     cmd.zone, (long)cmd.lat, (long)cmd.lon, (long)cmd.r, (long)cmd.ar, (long)cmd.rr, (long)cmd.bm);
      }
    }

    /* check LoRa downlink cmd command */
    {
      Lora_Cmd_t cmd;
      if (Lora_GetPendingCmd(&cmd))
      {
        if (strcmp(cmd.cmd, "stop") == 0)
        {
          Navigation_Stop();
          Lora_Printf("{\"t\":\"ack\",\"kind\":\"cmd\",\"cmd\":\"stop\"}\r\n");
        }
        else if (strcmp(cmd.cmd, "start") == 0)
        {
          Lora_Printf("{\"t\":\"ack\",\"kind\":\"cmd\",\"cmd\":\"start\"}\r\n");
        }
        else if (strcmp(cmd.cmd, "sensor") == 0)
        {
          Telemetry_SendData();
          last_telemetry_ms = HAL_GetTick();
          Lora_Printf("{\"t\":\"ack\",\"kind\":\"cmd\",\"cmd\":\"sensor\"}\r\n");
        }
        else if (strcmp(cmd.cmd, "dtest") == 0)
        {
          Navigation_Stop();
          /* 方向引脚直接测试：正转 2s → 反转 2s */
          HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_SET);
          HAL_GPIO_WritePin(GPIOC, GPIO_PIN_9, GPIO_PIN_RESET);
          HAL_GPIO_WritePin(GPIOC, GPIO_PIN_10, GPIO_PIN_SET);
          HAL_GPIO_WritePin(GPIOC, GPIO_PIN_11, GPIO_PIN_RESET);
          __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 500);
          __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, 500);
          Lora_Printf("{\"t\":\"ack\",\"kind\":\"dtest\",\"dir\":\"FWD\",\"pc_odr\":\"0x%04lx\",\"pc8\":%d,\"pc9\":%d}\r\n",
                       (unsigned long)(GPIOC->ODR & 0xFFFFUL),
                       (int)((GPIOC->ODR & GPIO_PIN_8) ? 1 : 0),
                       (int)((GPIOC->ODR & GPIO_PIN_9) ? 1 : 0));
          HAL_Delay(2000);
          HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_RESET);
          HAL_GPIO_WritePin(GPIOC, GPIO_PIN_9, GPIO_PIN_SET);
          HAL_GPIO_WritePin(GPIOC, GPIO_PIN_10, GPIO_PIN_RESET);
          HAL_GPIO_WritePin(GPIOC, GPIO_PIN_11, GPIO_PIN_SET);
          __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 500);
          __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, 500);
          Lora_Printf("{\"t\":\"ack\",\"kind\":\"dtest\",\"dir\":\"REV\",\"pc_odr\":\"0x%04lx\",\"pc8\":%d,\"pc9\":%d}\r\n",
                       (unsigned long)(GPIOC->ODR & 0xFFFFUL),
                       (int)((GPIOC->ODR & GPIO_PIN_8) ? 1 : 0),
                       (int)((GPIOC->ODR & GPIO_PIN_9) ? 1 : 0));
          HAL_Delay(2000);
          Motor_Stop_All();
          Lora_Printf("{\"t\":\"ack\",\"kind\":\"dtest\",\"msg\":\"done\"}\r\n");
        }
        else
        {
          Lora_Printf("{\"t\":\"ack\",\"kind\":\"cmd\",\"cmd\":\"%s\",\"err\":\"unknown\"}\r\n", cmd.cmd);
        }
      }
    }

    /* check LoRa downlink motor command */
    {
      Lora_MotorCmd_t cmd;
      if (Lora_GetPendingMotorCmd(&cmd))
      {
        Navigation_Stop();
        Lora_Printf("{\"t\":\"ack\",\"kind\":\"motor_raw\",\"l\":%ld,\"r\":%ld}\r\n",
                     (long)cmd.l, (long)cmd.r);
        Motor_Go_PWM(MOTOR_SPEED_LEFT, (int16_t)cmd.l);
        Motor_Go_PWM(MOTOR_SPEED_RIGHT, (int16_t)cmd.r);
        Lora_Printf("{\"t\":\"ack\",\"kind\":\"motor\",\"l\":%ld,\"r\":%ld}\r\n",
                     (long)cmd.l, (long)cmd.r);
      }
    }

    /* check LoRa downlink pid command (运行时整定，免重新烧录) */
    {
      Lora_PidCmd_t cmd;
      if (Lora_GetPendingPidCmd(&cmd))
      {
        Navigation_SetPid(cmd.hkp, cmd.hki, cmd.hkd, cmd.xkp, cmd.xki, cmd.xkd);
        Lora_Printf("{\"t\":\"ack\",\"kind\":\"pid\",\"hk\":%.3f,\"hi\":%.3f,\"hd\":%.3f,"
                    "\"xk\":%.3f,\"xi\":%.3f,\"xd\":%.3f}\r\n",
                    (double)heading_pid.kp, (double)heading_pid.ki, (double)heading_pid.kd,
                    (double)crosstrack_pid.kp, (double)crosstrack_pid.ki, (double)crosstrack_pid.kd);
      }
    }

    /* check LoRa downlink mcal (motor calibration) command */
    {
      Lora_MotorCalCmd_t cmd;
      if (Lora_GetPendingMotorCalCmd(&cmd))
      {
        Motor_SetCalibration(cmd.ls, cmd.rs, cmd.lo, cmd.ro, cmd.ldz, cmd.rdz);
        Lora_Printf("{\"t\":\"ack\",\"kind\":\"mcal\",\"ls\":%.2f,\"rs\":%.2f,\"lo\":%ld,\"ro\":%ld,"
                    "\"ldz\":%ld,\"rdz\":%ld}\r\n",
                     (double)motor_cal.left_scale, (double)motor_cal.right_scale,
                     (long)motor_cal.left_offset, (long)motor_cal.right_offset,
                     (long)motor_cal.left_deadzone, (long)motor_cal.right_deadzone);
      }
    }

    {
      uint32_t now = HAL_GetTick();

      /* 温度采集状态机：非阻塞，必须在主循环里持续推进 */
      DS18B20_Update();

      if ((now - last_nav_update_ms) >= NAV_UPDATE_PERIOD_MS)
      {
        Navigation_Update();
        last_nav_update_ms = now;
      }

      if ((now - last_telemetry_ms) >= TELEMETRY_PERIOD_MS)
      {
        Telemetry_SendData();
        last_telemetry_ms = now;
      }
    }

    HAL_Delay(20);
  }
  /* USER CODE END 3 */
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  /** Configure the main internal regulator output voltage
  */
  if (HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the CPU, AHB and APB buses clocks
  */
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI|RCC_OSCILLATORTYPE_MSI;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.MSIState = RCC_MSI_ON;
  RCC_OscInitStruct.MSICalibrationValue = RCC_MSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.MSIClockRange = RCC_MSIRANGE_0;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_MSI;
  RCC_OscInitStruct.PLL.PLLMBOOST = RCC_PLLMBOOST_DIV4;
  RCC_OscInitStruct.PLL.PLLM = 3;
  RCC_OscInitStruct.PLL.PLLN = 10;
  RCC_OscInitStruct.PLL.PLLP = 2;
  RCC_OscInitStruct.PLL.PLLQ = 2;
  RCC_OscInitStruct.PLL.PLLR = 1;
  RCC_OscInitStruct.PLL.PLLRGE = RCC_PLLVCIRANGE_1;
  RCC_OscInitStruct.PLL.PLLFRACN = 0;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the CPU, AHB and APB buses clocks
  */
  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2
                              |RCC_CLOCKTYPE_PCLK3;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV1;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;
  RCC_ClkInitStruct.APB3CLKDivider = RCC_HCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_4) != HAL_OK)
  {
    Error_Handler();
  }
}

/* USER CODE BEGIN 4 */

/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
  /* USER CODE BEGIN Error_Handler_Debug */
  /* User can add his own implementation to report the HAL error return state */
  __disable_irq();
  while (1)
  {
  }
  /* USER CODE END Error_Handler_Debug */
}

#ifdef USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t *file, uint32_t line)
{
  /* USER CODE BEGIN 6 */
  /* User can add his own implementation to report the file name and line number,
     ex: printf("Wrong parameters value: file %s on line %d\r\n", file, line) */
  /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
