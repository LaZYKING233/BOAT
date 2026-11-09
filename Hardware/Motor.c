#include "Motor.h"
#include "tim.h"
#include "gpio.h"
#include <stdlib.h>
#include <math.h>

MotorCal_t motor_cal = { 1.0f, 1.0f, 0, 0, 0, 0 };

/* 最近一次实际下发的 PWM（带符号），供遥测上报 */
static int16_t motor_last_pwm[4] = { 0, 0, 0, 0 };

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
    int32_t cmd;
    int32_t magnitude;
    float   scale;
    int16_t offset;
    int16_t deadzone;

    if (speed > 100) speed = 100;
    if (speed < -100) speed = -100;

    cmd = abs((int)speed);   /* 0..100，方向由下面的方向脚决定 */

    /* 取该电机的校准参数 */
    if (motor == MOTOR_SPEED_LEFT)
    {
        scale = motor_cal.left_scale;
        offset = motor_cal.left_offset;
        deadzone = motor_cal.left_deadzone;
    }
    else if (motor == MOTOR_SPEED_RIGHT)
    {
        scale = motor_cal.right_scale;
        offset = motor_cal.right_offset;
        deadzone = motor_cal.right_deadzone;
    }
    else
    {
        scale = 1.0f;
        offset = 0;
        deadzone = 0;
    }

    if (cmd > 0)
    {
        if (deadzone < 0) deadzone = 0;
        if (deadzone > 600) deadzone = 600;

        /* 死区补偿：把指令 1..100 线性映射到 deadzone..999。
         * 不做这一步时，cmd=1..5 只输出 10..50 counts，电机不转，
         * PID 在这个区间等于空转，一过阈值就猛冲 —— 这是调不稳的根源。 */
        magnitude = deadzone + ((999 - deadzone) * cmd) / 100;

        magnitude = (int32_t)(magnitude * scale) + offset;

        if (magnitude < 1) magnitude = 1;      /* 非零指令至少给 1，别被 scale/offset 抹平 */
        if (magnitude > 999) magnitude = 999;
    }
    else
    {
        /* 零指令必须是零输出。原来这里会加上 offset，
         * 导致 speed=0 时仍有 10 counts 输出，船在"停"的状态下慢慢蠕动。 */
        magnitude = 0;
    }

    pwm_value = (uint16_t)magnitude;

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

    if ((unsigned)motor < 4U)
    {
        motor_last_pwm[motor] = (speed >= 0) ? (int16_t)pwm_value : (int16_t)(-pwm_value);
    }
}

int16_t Motor_GetLastPwm(MotorId motor)
{
    return ((unsigned)motor < 4U) ? motor_last_pwm[motor] : 0;
}

// 停止所有电机
void Motor_Stop_All(void)
{
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 0);
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, 0);
	__HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, 0);
	__HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_4, 0);

    motor_last_pwm[0] = 0;
    motor_last_pwm[1] = 0;
    motor_last_pwm[2] = 0;
    motor_last_pwm[3] = 0;
}

void Motor_SetCalibration(float left_scale, float right_scale,
                          int16_t left_offset, int16_t right_offset,
                          int16_t left_deadzone, int16_t right_deadzone)
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

    /* 负数 = 保持当前值，方便上位机只改缩放 */
    if (left_deadzone >= 0)
    {
        if (left_deadzone > 600) left_deadzone = 600;
        motor_cal.left_deadzone = left_deadzone;
    }
    if (right_deadzone >= 0)
    {
        if (right_deadzone > 600) right_deadzone = 600;
        motor_cal.right_deadzone = right_deadzone;
    }
}
