#include "Motor.h"
#include "tim.h"
#include "gpio.h"
#include <stdlib.h>
#include <math.h>

MotorCal_t motor_cal = { 1.0f, 1.0f, 0, 0 };

void Motor_Init(void)
{
	HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);
	HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_2);
	HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_3);
	HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_4);
	
	TIM1->BDTR |= TIM_BDTR_MOE;
}

void Motor_Go_PWM(MotorId motor, int16_t speed)
{
    uint16_t pwm_value;
    int32_t calibrated;

    if (speed > 100) speed = 100;
    if (speed < -100) speed = -100;

    pwm_value = (uint16_t)(abs((int)speed) * 999 / 100);

    /* 仅对推进电机应用校准 */
    if (motor == MOTOR_SPEED_LEFT)
    {
        calibrated = (int32_t)(pwm_value * motor_cal.left_scale) + motor_cal.left_offset;
        if (calibrated < 0) calibrated = 0;
        if (calibrated > 999) calibrated = 999;
        pwm_value = (uint16_t)calibrated;
    }
    else if (motor == MOTOR_SPEED_RIGHT)
    {
        calibrated = (int32_t)(pwm_value * motor_cal.right_scale) + motor_cal.right_offset;
        if (calibrated < 0) calibrated = 0;
        if (calibrated > 999) calibrated = 999;
        pwm_value = (uint16_t)calibrated;
    }

    if (motor == MOTOR_SPEED_LEFT)
    {
        if (speed >= 0)
		{
            HAL_GPIO_WritePin(DIR_PORT_1, SPEED_LEFT_DIR_PIN1, GPIO_PIN_SET);
			HAL_GPIO_WritePin(DIR_PORT_1, SPEED_LEFT_DIR_PIN2, GPIO_PIN_RESET);
		}
        else
		{
            HAL_GPIO_WritePin(DIR_PORT_1, SPEED_LEFT_DIR_PIN1, GPIO_PIN_RESET);
			HAL_GPIO_WritePin(DIR_PORT_1, SPEED_LEFT_DIR_PIN2, GPIO_PIN_SET);
		}

        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, pwm_value);
    }
    else if(motor == MOTOR_SPEED_RIGHT)
    {
        if (speed >= 0)
		{
            HAL_GPIO_WritePin(DIR_PORT_1, SPEED_RIGHT_DIR_PIN1, GPIO_PIN_SET);
			HAL_GPIO_WritePin(DIR_PORT_1, SPEED_RIGHT_DIR_PIN2, GPIO_PIN_RESET);
		}
        else
		{
            HAL_GPIO_WritePin(DIR_PORT_1, SPEED_RIGHT_DIR_PIN1, GPIO_PIN_RESET);
			HAL_GPIO_WritePin(DIR_PORT_1, SPEED_RIGHT_DIR_PIN2, GPIO_PIN_SET);
		}

        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, pwm_value);
    }
	else if(motor == MOTOR_TURN_LEFT)
    {
        if (speed >= 0)
		{
            HAL_GPIO_WritePin(DIR_PORT_1, TURN_LEFT_DIR_PIN1, GPIO_PIN_SET); 
			HAL_GPIO_WritePin(DIR_PORT_2, TURN_LEFT_DIR_PIN2, GPIO_PIN_RESET);	
		}
        else
		{
            HAL_GPIO_WritePin(DIR_PORT_1, TURN_LEFT_DIR_PIN1, GPIO_PIN_RESET);
			HAL_GPIO_WritePin(DIR_PORT_2, TURN_LEFT_DIR_PIN2, GPIO_PIN_SET);
		}

        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, pwm_value);
    }
	else if(motor == MOTOR_TURN_RIGHT)
    {
        if (speed >= 0)
		{
            HAL_GPIO_WritePin(DIR_PORT_3, TURN_RIGHT_DIR_PIN1, GPIO_PIN_SET); 
			HAL_GPIO_WritePin(DIR_PORT_3, TURN_RIGHT_DIR_PIN2, GPIO_PIN_RESET);	
		}
        else
		{
            HAL_GPIO_WritePin(DIR_PORT_3, TURN_RIGHT_DIR_PIN1, GPIO_PIN_RESET);
			HAL_GPIO_WritePin(DIR_PORT_3, TURN_RIGHT_DIR_PIN2, GPIO_PIN_SET);
		}

        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_4, pwm_value);
    }
}

// 停止所有电机
void Motor_Stop_All(void)
{
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 0);
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, 0);
	__HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, 0);
	__HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_4, 0);

}

void Motor_SetCalibration(float left_scale, float right_scale, int16_t left_offset, int16_t right_offset)
{
    if (left_scale < 0.1f) left_scale = 0.1f;
    if (left_scale > 2.0f) left_scale = 2.0f;
    if (right_scale < 0.1f) right_scale = 0.1f;
    if (right_scale > 2.0f) right_scale = 2.0f;
    if (left_offset < -200) left_offset = -200;
    if (left_offset > 200) left_offset = 200;
    if (right_offset < -200) right_offset = -200;
    if (right_offset > 200) right_offset = 200;

    motor_cal.left_scale = left_scale;
    motor_cal.right_scale = right_scale;
    motor_cal.left_offset = left_offset;
    motor_cal.right_offset = right_offset;
}
