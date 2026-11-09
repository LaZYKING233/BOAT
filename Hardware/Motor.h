#ifndef __MOTOR_H__
#define __MOTOR_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"

#define SPEED_LEFT_PWM_PIN        GPIO_PIN_9
#define SPEED_LEFT_PWM_PORT       GPIOE
#define SPEED_RIGHT_PWM_PIN       GPIO_PIN_11
#define SPEED_RIGHT_PWM_PORT      GPIOE
#define TURN_LEFT_PWM_PIN         GPIO_PIN_13
#define TURN_LEFT_PWM_PORT        GPIOE
#define TURN_RIGHT_PWM_PIN        GPIO_PIN_14
#define TURN_RIGHT_PWM_PORT       GPIOE

#define SPEED_LEFT_DIR_PIN1       GPIO_PIN_8
#define SPEED_LEFT_DIR_PIN2       GPIO_PIN_9
#define SPEED_RIGHT_DIR_PIN1      GPIO_PIN_10
#define SPEED_RIGHT_DIR_PIN2      GPIO_PIN_11

#define TURN_LEFT_DIR_PIN1        GPIO_PIN_12
#define TURN_LEFT_DIR_PIN2        GPIO_PIN_2
#define TURN_RIGHT_DIR_PIN1       GPIO_PIN_13
#define TURN_RIGHT_DIR_PIN2       GPIO_PIN_14

#define DIR_PORT_1            GPIOC
#define DIR_PORT_2            GPIOD
#define DIR_PORT_3            GPIOB

typedef enum {
    MOTOR_SPEED_LEFT = 0,
    MOTOR_SPEED_RIGHT =1,
	MOTOR_TURN_LEFT = 2,
	MOTOR_TURN_RIGHT = 3,
} MotorId;

typedef struct {
    float left_scale;     // 左电机 PWM 缩放系数 (1.0 = 不缩放)
    float right_scale;    // 右电机 PWM 缩放系数
    int16_t left_offset;  // 左电机 PWM 偏移 (补偿死区)
    int16_t right_offset; // 右电机 PWM 偏移
} MotorCal_t;

extern MotorCal_t motor_cal;

void Motor_Init(void);
void Motor_Go_PWM(MotorId motor, int16_t pulse);

/**
 * @brief  取最近一次实际下发给电机的 PWM（带符号，-999~999）
 * @note   用于遥测上报，PID 整定时需要看到"控制器输出了多少"，
 *         否则无法区分"增益过大产生振荡"与"输出长期饱和、积分在发散"。
 */
int16_t Motor_GetLastPwm(MotorId motor);
void Motor_Stop_All(void);
void Motor_SetCalibration(float left_scale, float right_scale, int16_t left_offset, int16_t right_offset);

#ifdef __cplusplus
}
#endif

#endif
