#ifndef __NAVIGATION_H__
#define __NAVIGATION_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "main.h"

#define NAV_ARRIVE_RADIUS   5.0f    // 到达判定半径(米)
#define NAV_HOLD_RADIUS     5.0f    // 区域保持半径(米)
#define NAV_DRIFT_RADIUS    8.0f    // 漂移修正触发半径(米)，超过此距离返回目标
#define NAV_BASE_SPEED      60      // 基础前进速度(PWM 0-100)
#define NAV_MAX_TURN_SPEED  80      // 最大转向速度(PWM 0-100)
#define NAV_HOLD_SPEED      30      // 保持/修正速度(PWM 0-100)

// 导航状态
typedef enum
{
    NAV_IDLE = 0,       // 空闲
    NAV_NAVIGATING,     // 导航中
    NAV_HOLDING,        // 区域保持/定点保持
    NAV_NO_GPS,         // GPS未定位
} NavState_t;

// PID参数结构体
typedef struct
{
    float kp;
    float ki;
    float kd;
    float integral;
    float prev_error;
    float integral_limit;
    float output_limit;
} PID_t;

// 导航结构体
typedef struct
{
    float target_lat;       // 目标纬度
    float target_lon;       // 目标经度
    NavState_t state;       // 导航状态
    float distance;         // 到目标距离(米)
    float target_heading;   // 目标航向角(度)
    float heading_error;    // 航向误差(度)
    int16_t turn_output;    // 转向输出
    int16_t speed_output;   // 速度输出
} Navigation_t;

extern Navigation_t nav;
extern PID_t heading_pid;

void Navigation_Init(void);
void Navigation_SetTarget(float lat, float lon);
void Navigation_Start(void);
void Navigation_Stop(void);
void Navigation_Update(void);
float Navigation_CalcDistance(float lat1, float lon1, float lat2, float lon2);
float Navigation_CalcBearing(float lat1, float lon1, float lat2, float lon2);
float Navigation_NormalizeAngle(float angle);

void PID_Init(PID_t *pid, float kp, float ki, float kd, float integral_limit, float output_limit);
float PID_Calculate(PID_t *pid, float error);

#ifdef __cplusplus
}
#endif

#endif
