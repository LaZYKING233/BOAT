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
    float left_scale;       // 左电机 PWM 缩放系数 (1.0 = 不缩放)
    float right_scale;      // 右电机 PWM 缩放系数
    int16_t left_offset;    // 左电机 PWM 微调偏移（仅在非零指令时生效）
    int16_t right_offset;   // 右电机 PWM 微调偏移
    int16_t left_deadzone;  // 左电机启动死区（PWM counts，0 = 不补偿）
    int16_t right_deadzone; // 右电机启动死区
    int8_t  dir_sign;       // 方向符号：+1 正常，-1 反向（两个推进电机一起翻）
                            // 实测若"给正指令船往后退"，把它设成 -1 即可，
                            // 不用拆线换极性。
} MotorCal_t;

extern MotorCal_t motor_cal;

void Motor_Init(void);
void Motor_Go_PWM(MotorId motor, int16_t pulse);

/** 设置推进电机的方向符号（+1 正常 / -1 反向），运行时可用 */
void Motor_SetDirSign(int8_t sign);
int8_t Motor_GetDirSign(void);

/**
 * @brief  取最近一次实际下发给电机的 PWM（带符号，-999~999）
 * @note   用于遥测上报，PID 整定时需要看到"控制器输出了多少"，
 *         否则无法区分"增益过大产生振荡"与"输出长期饱和、积分在发散"。
 */
int16_t Motor_GetLastPwm(MotorId motor);
void Motor_Stop_All(void);
/**
 * @brief 设置电机校准
 * @note  deadzone 传负数表示"保持当前值"（上位机可以只改缩放/偏移）
 */
void Motor_SetCalibration(float left_scale, float right_scale,
                          int16_t left_offset, int16_t right_offset,
                          int16_t left_deadzone, int16_t right_deadzone);

#ifdef __cplusplus
}
#endif

#endif
