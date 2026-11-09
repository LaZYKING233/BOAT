#include "Navigation.h"
#include "GPS.h"
#include "IMU901.h"
#include "Motor.h"
#include <math.h>

#define EARTH_RADIUS 6371000.0f  // 地球半径(米)

Navigation_t nav;
PID_t heading_pid;

void PID_Init(PID_t *pid, float kp, float ki, float kd, float integral_limit, float output_limit)
{
    pid->kp = kp;
    pid->ki = ki;
    pid->kd = kd;
    pid->integral = 0;
    pid->prev_error = 0;
    pid->integral_limit = integral_limit;
    pid->output_limit = output_limit;
}

float PID_Calculate(PID_t *pid, float error)
{
    float output;

    // 积分
    pid->integral += error;

    // 积分限幅
    if (pid->integral > pid->integral_limit)
        pid->integral = pid->integral_limit;
    if (pid->integral < -pid->integral_limit)
        pid->integral = -pid->integral_limit;

    // PID计算
    output = pid->kp * error
           + pid->ki * pid->integral
           + pid->kd * (error - pid->prev_error);

    pid->prev_error = error;

    // 输出限幅
    if (output > pid->output_limit)
        output = pid->output_limit;
    if (output < -pid->output_limit)
        output = -pid->output_limit;

    return output;
}

// 角度归一化到 -180 ~ 180
float Navigation_NormalizeAngle(float angle)
{
    while (angle > 180.0f) angle -= 360.0f;
    while (angle < -180.0f) angle += 360.0f;
    return angle;
}

// 计算两点间距离(米)，使用Haversine公式
float Navigation_CalcDistance(float lat1, float lon1, float lat2, float lon2)
{
    float dlat, dlon, a, c;

    dlat = (lat2 - lat1) * 3.14159265f / 180.0f;
    dlon = (lon2 - lon1) * 3.14159265f / 180.0f;

    a = sinf(dlat / 2.0f) * sinf(dlat / 2.0f)
      + cosf(lat1 * 3.14159265f / 180.0f)
      * cosf(lat2 * 3.14159265f / 180.0f)
      * sinf(dlon / 2.0f) * sinf(dlon / 2.0f);

    c = 2.0f * atan2f(sqrtf(a), sqrtf(1.0f - a));

    return EARTH_RADIUS * c;
}

// 计算从点1到点2的航向角(度)，正北为0，顺时针为正
float Navigation_CalcBearing(float lat1, float lon1, float lat2, float lon2)
{
    float dlat, dlon, x, y, bearing;

    dlat = (lat2 - lat1) * 3.14159265f / 180.0f;
    dlon = (lon2 - lon1) * 3.14159265f / 180.0f;

    x = sinf(dlon) * cosf(lat2 * 3.14159265f / 180.0f);
    y = cosf(lat1 * 3.14159265f / 180.0f) * sinf(lat2 * 3.14159265f / 180.0f)
      - sinf(lat1 * 3.14159265f / 180.0f) * cosf(lat2 * 3.14159265f / 180.0f) * cosf(dlon);

    bearing = atan2f(x, y) * 180.0f / 3.14159265f;

    return Navigation_NormalizeAngle(bearing);
}

void Navigation_Init(void)
{
    nav.target_lat = 0;
    nav.target_lon = 0;
    nav.state = NAV_IDLE;
    nav.distance = 0;
    nav.target_heading = 0;
    nav.heading_error = 0;
    nav.turn_output = 0;
    nav.speed_output = 0;

    // 航向PID参数（需要根据实际调试调整）
    // kp: 比例系数 - 航向误差1度时转向输出的基本量
    // ki: 积分系数 - 抵消持续的风/水流偏移
    // kd: 微分系数 - 抑制转向振荡
    PID_Init(&heading_pid, 2.0f, 0.05f, 1.0f, 500.0f, (float)NAV_MAX_TURN_SPEED);
}

void Navigation_SetTarget(float lat, float lon)
{
    nav.target_lat = lat;
    nav.target_lon = lon;
}

void Navigation_Start(void)
{
    if (nav.target_lat != 0 || nav.target_lon != 0)
    {
        nav.state = NAV_NAVIGATING;
        // 重置PID积分项
        heading_pid.integral = 0;
        heading_pid.prev_error = 0;
    }
}

void Navigation_Stop(void)
{
    nav.state = NAV_IDLE;
    Motor_Stop_All();
}

// 导航更新函数，在主循环中周期性调用
// 内部：执行导航/保持的电机输出
static void Navigation_DriveToTarget(float current_lat, float current_lon, float current_yaw, int16_t base_speed)
{
    int16_t left_speed, right_speed;

    // 计算目标航向角
    nav.target_heading = Navigation_CalcBearing(current_lat, current_lon,
                                                 nav.target_lat, nav.target_lon);

    // 计算航向误差（归一化到 -180 ~ 180）
    nav.heading_error = Navigation_NormalizeAngle(nav.target_heading - current_yaw);

    // PID计算转向输出
    nav.turn_output = (int16_t)PID_Calculate(&heading_pid, nav.heading_error);

    // 根据航向误差调整前进速度
    if (fabsf(nav.heading_error) > 60.0f)
        nav.speed_output = base_speed / 3;
    else if (fabsf(nav.heading_error) > 30.0f)
        nav.speed_output = base_speed / 2;
    else
        nav.speed_output = base_speed;

    // 左右推进电机：基础速度 + 转向修正
    left_speed = nav.speed_output + nav.turn_output;
    right_speed = nav.speed_output - nav.turn_output;

    // 限幅
    if (left_speed > 100) left_speed = 100;
    if (left_speed < -100) left_speed = -100;
    if (right_speed > 100) right_speed = 100;
    if (right_speed < -100) right_speed = -100;

    Motor_Go_PWM(MOTOR_SPEED_LEFT, left_speed);
    Motor_Go_PWM(MOTOR_SPEED_RIGHT, right_speed);
}

void Navigation_Update(void)
{
    float current_lat, current_lon, current_yaw;

    if (nav.state == NAV_IDLE)
    {
        return;
    }

    // 检查GPS是否定位
    if (!GPS_IsFixed())
    {
        if (nav.state == NAV_NAVIGATING || nav.state == NAV_HOLDING)
        {
            nav.state = NAV_NO_GPS;
            Motor_Stop_All();
        }
        return;
    }
    else if (nav.state == NAV_NO_GPS)
    {
        // GPS恢复，回到导航
        nav.state = NAV_NAVIGATING;
    }

    // 获取当前位置
    current_lat = GPS_GetLatitude();
    current_lon = GPS_GetLongitude();
    current_yaw = IMU901_GetYaw();

    // 计算到目标点的距离
    nav.distance = Navigation_CalcDistance(current_lat, current_lon,
                                            nav.target_lat, nav.target_lon);

    if (nav.state == NAV_NAVIGATING)
    {
        // 判断是否到达
        if (nav.distance < NAV_ARRIVE_RADIUS)
        {
            nav.state = NAV_HOLDING;
            Motor_Stop_All();
            return;
        }

        Navigation_DriveToTarget(current_lat, current_lon, current_yaw, NAV_BASE_SPEED);
    }
    else if (nav.state == NAV_HOLDING)
    {
        // 区域保持：如果漂移超出保持半径，修正回目标
        if (nav.distance > NAV_DRIFT_RADIUS)
        {
            Navigation_DriveToTarget(current_lat, current_lon, current_yaw, NAV_HOLD_SPEED);
        }
        else
        {
            // 在保持半径内，停止电机
            Motor_Stop_All();
            nav.turn_output = 0;
            nav.speed_output = 0;
        }
    }
}
