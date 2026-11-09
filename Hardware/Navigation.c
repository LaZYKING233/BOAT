#include "Navigation.h"
#include "GPS.h"
#include "IMU901.h"
#include "Motor.h"
#include <math.h>

#define EARTH_RADIUS 6371000.0f  // 地球半径(米)
#define NAV_MIN_RADIUS_M 0.5f
#define NAV_MAX_RADIUS_M 200.0f
#define NAV_CROSS_TRACK_LIMIT_DEG 30.0f
#define NAV_CROSS_TRACK_GAIN_DEG_PER_M 1.5f
#define NAV_FINAL_APPROACH_M 10.0f

Navigation_t nav;
PID_t heading_pid;
PID_t crosstrack_pid;

static float Navigation_ClampFloat(float value, float min_value, float max_value)
{
    if (value < min_value) return min_value;
    if (value > max_value) return max_value;
    return value;
}

static float Navigation_DefaultRadius(float value, float fallback)
{
    if (value < NAV_MIN_RADIUS_M || value > NAV_MAX_RADIUS_M)
    {
        return fallback;
    }
    return value;
}

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
    float dlon, x, y, bearing;

    dlon = (lon2 - lon1) * 3.14159265f / 180.0f;

    x = sinf(dlon) * cosf(lat2 * 3.14159265f / 180.0f);
    y = cosf(lat1 * 3.14159265f / 180.0f) * sinf(lat2 * 3.14159265f / 180.0f)
      - sinf(lat1 * 3.14159265f / 180.0f) * cosf(lat2 * 3.14159265f / 180.0f) * cosf(dlon);

    bearing = atan2f(x, y) * 180.0f / 3.14159265f;

    return Navigation_NormalizeAngle(bearing);
}

static void Navigation_LocalOffsetMeters(float ref_lat, float ref_lon, float lat, float lon, float *east_m, float *north_m)
{
    float meters_lon = 111320.0f * cosf(ref_lat * 3.14159265f / 180.0f);
    if (fabsf(meters_lon) < 1.0f) meters_lon = 1.0f;
    *north_m = (lat - ref_lat) * 111320.0f;
    *east_m = (lon - ref_lon) * meters_lon;
}

static void Navigation_ResetLeg(void)
{
    nav.leg_valid = 0;
    nav.start_lat = 0;
    nav.start_lon = 0;
    nav.leg_bearing = 0;
    nav.leg_distance = 0;
    nav.cross_track_error_m = 0;
    nav.corrected_heading = 0;
    crosstrack_pid.integral = 0;
    crosstrack_pid.prev_error = 0;
}

static void Navigation_UpdateLegStart(void)
{
    if (GPS_IsFixed())
    {
        nav.start_lat = GPS_GetLatitude();
        nav.start_lon = GPS_GetLongitude();
        nav.leg_distance = Navigation_CalcDistance(nav.start_lat, nav.start_lon, nav.target_lat, nav.target_lon);
        nav.leg_bearing = Navigation_CalcBearing(nav.start_lat, nav.start_lon, nav.target_lat, nav.target_lon);
        nav.leg_valid = nav.leg_distance > 1.0f;
    }
    else
    {
        Navigation_ResetLeg();
    }
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
    nav.arrive_radius_m = NAV_ARRIVE_RADIUS;
    nav.hold_radius_m = NAV_HOLD_RADIUS;
    nav.drift_radius_m = NAV_DRIFT_RADIUS;
    nav.boundary_enabled = 0;
    nav.boundary_center_lat = 0;
    nav.boundary_center_lon = 0;
    nav.boundary_length_m = 0;
    nav.boundary_width_m = 0;
    nav.boundary_margin_m = NAV_BOUNDARY_MARGIN;
    nav.boundary_state = NAV_BOUNDARY_DISABLED;
    nav.return_state = NAV_RETURN_NONE;
    nav.boundary_distance_m = 0;
    nav.return_distance_m = 0;
    Navigation_ResetLeg();

    // 航向PID参数（需要根据实际调试调整）
    // kp: 比例系数 - 航向误差1度时转向输出的基本量
    // ki: 积分系数 - 抵消持续的风/水流偏移
    // kd: 微分系数 - 抑制转向振荡
    PID_Init(&heading_pid, 2.0f, 0.05f, 1.0f, 500.0f, (float)NAV_MAX_TURN_SPEED);

    // 横向偏差PID输出为航向修正角，抑制水流/风导致的离线漂移
    PID_Init(&crosstrack_pid, 0.8f, 0.02f, 0.2f, 80.0f, NAV_CROSS_TRACK_LIMIT_DEG);
}

void Navigation_SetTarget(float lat, float lon)
{
    Navigation_SetMissionTarget(lat, lon,
                                NAV_ARRIVE_RADIUS, NAV_HOLD_RADIUS, NAV_DRIFT_RADIUS,
                                0, 0, 0, 0, NAV_BOUNDARY_MARGIN);
}

void Navigation_SetMissionTarget(float lat, float lon,
                                 float arrive_radius_m, float hold_radius_m, float drift_radius_m,
                                 float boundary_center_lat, float boundary_center_lon,
                                 float boundary_length_m, float boundary_width_m, float boundary_margin_m)
{
    nav.target_lat = lat;
    nav.target_lon = lon;
    nav.arrive_radius_m = Navigation_DefaultRadius(arrive_radius_m, NAV_ARRIVE_RADIUS);
    nav.hold_radius_m = Navigation_DefaultRadius(hold_radius_m, NAV_HOLD_RADIUS);
    nav.drift_radius_m = Navigation_DefaultRadius(drift_radius_m, NAV_DRIFT_RADIUS);

    if (boundary_length_m > 0.1f && boundary_width_m > 0.1f)
    {
        nav.boundary_enabled = 1;
        nav.boundary_center_lat = boundary_center_lat;
        nav.boundary_center_lon = boundary_center_lon;
        nav.boundary_length_m = boundary_length_m;
        nav.boundary_width_m = boundary_width_m;
        nav.boundary_margin_m = boundary_margin_m < 0.0f ? 0.0f : boundary_margin_m;
        nav.boundary_state = NAV_BOUNDARY_INSIDE;
    }
    else
    {
        nav.boundary_enabled = 0;
        nav.boundary_state = NAV_BOUNDARY_DISABLED;
    }

    nav.return_state = NAV_RETURN_NONE;
    nav.boundary_distance_m = 0;
    nav.return_distance_m = 0;
    Navigation_ResetLeg();
}

void Navigation_Start(void)
{
    if (nav.target_lat != 0 || nav.target_lon != 0)
    {
        nav.state = NAV_NAVIGATING;
        nav.return_state = NAV_RETURN_NONE;
        // 重置PID积分项
        heading_pid.integral = 0;
        heading_pid.prev_error = 0;
        crosstrack_pid.integral = 0;
        crosstrack_pid.prev_error = 0;
        Navigation_UpdateLegStart();
    }
}

void Navigation_Stop(void)
{
    nav.state = NAV_IDLE;
    nav.return_state = NAV_RETURN_NONE;
    Motor_Stop_All();
}

static int Navigation_UpdateBoundaryState(float current_lat, float current_lon)
{
    float east_m, north_m, half_width, half_length, safe_width, safe_length;
    float inside_x, inside_y, outside_x, outside_y, outside_distance;

    if (!nav.boundary_enabled)
    {
        nav.boundary_state = NAV_BOUNDARY_DISABLED;
        nav.boundary_distance_m = 0;
        return 0;
    }

    Navigation_LocalOffsetMeters(nav.boundary_center_lat, nav.boundary_center_lon, current_lat, current_lon, &east_m, &north_m);
    half_width = nav.boundary_width_m / 2.0f;
    half_length = nav.boundary_length_m / 2.0f;
    safe_width = half_width + nav.boundary_margin_m;
    safe_length = half_length + nav.boundary_margin_m;

    outside_x = fabsf(east_m) - safe_width;
    outside_y = fabsf(north_m) - safe_length;

    if (outside_x <= 0.0f && outside_y <= 0.0f)
    {
        inside_x = safe_width - fabsf(east_m);
        inside_y = safe_length - fabsf(north_m);
        nav.boundary_distance_m = inside_x < inside_y ? inside_x : inside_y;
        nav.boundary_state = nav.boundary_distance_m <= nav.boundary_margin_m ? NAV_BOUNDARY_MARGIN_ZONE : NAV_BOUNDARY_INSIDE;
        return 0;
    }

    if (outside_x < 0.0f) outside_x = 0.0f;
    if (outside_y < 0.0f) outside_y = 0.0f;
    outside_distance = sqrtf(outside_x * outside_x + outside_y * outside_y);
    nav.boundary_distance_m = -outside_distance;
    nav.boundary_state = NAV_BOUNDARY_OUTSIDE;
    return 1;
}

static float Navigation_CrossTrackHeading(float current_lat, float current_lon)
{
    float target_east, target_north, current_east, current_north;
    float leg_len, cross_track, correction, direct_heading, blend;

    direct_heading = Navigation_CalcBearing(current_lat, current_lon, nav.target_lat, nav.target_lon);

    if (!nav.leg_valid || nav.leg_distance < 1.0f)
    {
        nav.cross_track_error_m = 0;
        nav.corrected_heading = direct_heading;
        return direct_heading;
    }

    Navigation_LocalOffsetMeters(nav.start_lat, nav.start_lon, nav.target_lat, nav.target_lon, &target_east, &target_north);
    Navigation_LocalOffsetMeters(nav.start_lat, nav.start_lon, current_lat, current_lon, &current_east, &current_north);
    leg_len = sqrtf(target_east * target_east + target_north * target_north);
    if (leg_len < 1.0f)
    {
        nav.cross_track_error_m = 0;
        nav.corrected_heading = direct_heading;
        return direct_heading;
    }

    cross_track = (target_east * current_north - target_north * current_east) / leg_len;
    nav.cross_track_error_m = cross_track;
    correction = -cross_track * NAV_CROSS_TRACK_GAIN_DEG_PER_M + PID_Calculate(&crosstrack_pid, -cross_track);
    correction = Navigation_ClampFloat(correction, -NAV_CROSS_TRACK_LIMIT_DEG, NAV_CROSS_TRACK_LIMIT_DEG);

    // 临近目标时逐步切回直达目标，避免为贴线而绕过目标点
    blend = Navigation_ClampFloat(nav.distance / NAV_FINAL_APPROACH_M, 0.0f, 1.0f);
    nav.corrected_heading = Navigation_NormalizeAngle(direct_heading + correction * blend);
    return nav.corrected_heading;
}

// 导航更新函数，在主循环中周期性调用
// 内部：执行导航/保持的电机输出
static void Navigation_DriveHeading(float desired_heading, float current_yaw, int16_t base_speed)
{
    int16_t left_speed, right_speed;

    nav.target_heading = Navigation_NormalizeAngle(desired_heading);

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

static void Navigation_DriveToPoint(float current_lat, float current_lon, float current_yaw, float target_lat, float target_lon, int16_t base_speed)
{
    Navigation_DriveHeading(Navigation_CalcBearing(current_lat, current_lon, target_lat, target_lon), current_yaw, base_speed);
}

void Navigation_Update(void)
{
    float current_lat, current_lon, current_yaw, desired_heading;
    NavState_t resume_state;

    if (nav.state == NAV_IDLE)
    {
        return;
    }

    // 检查GPS是否定位
    if (!GPS_IsFixed())
    {
        if (nav.state == NAV_NAVIGATING || nav.state == NAV_HOLDING || nav.state == NAV_RETURNING)
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
        Navigation_UpdateLegStart();
    }

    // 获取当前位置
    current_lat = GPS_GetLatitude();
    current_lon = GPS_GetLongitude();
    current_yaw = IMU901_GetYaw();

    // 计算到目标点的距离
    nav.distance = Navigation_CalcDistance(current_lat, current_lon,
                                            nav.target_lat, nav.target_lon);

    if (Navigation_UpdateBoundaryState(current_lat, current_lon))
    {
        nav.state = NAV_RETURNING;
        nav.return_state = NAV_RETURN_ACTIVE;
        nav.return_distance_m = Navigation_CalcDistance(current_lat, current_lon,
                                                        nav.boundary_center_lat, nav.boundary_center_lon);
        Navigation_DriveToPoint(current_lat, current_lon, current_yaw,
                                nav.boundary_center_lat, nav.boundary_center_lon, NAV_HOLD_SPEED);
        return;
    }
    else if (nav.state == NAV_RETURNING)
    {
        nav.return_state = NAV_RETURN_RECOVERED;
        Navigation_UpdateLegStart();
        nav.state = nav.distance < nav.arrive_radius_m ? NAV_HOLDING : NAV_NAVIGATING;
    }

    if (nav.state == NAV_NAVIGATING)
    {
        // 判断是否到达
        if (nav.distance < nav.arrive_radius_m)
        {
            nav.state = NAV_HOLDING;
            Motor_Stop_All();
            return;
        }

        desired_heading = Navigation_CrossTrackHeading(current_lat, current_lon);
        Navigation_DriveHeading(desired_heading, current_yaw, NAV_BASE_SPEED);
    }
    else if (nav.state == NAV_HOLDING)
    {
        // 区域保持：如果漂移超出保持半径，修正回目标
        if (nav.distance > nav.drift_radius_m)
        {
            resume_state = nav.state;
            nav.state = NAV_NAVIGATING;
            Navigation_DriveToPoint(current_lat, current_lon, current_yaw, nav.target_lat, nav.target_lon, NAV_HOLD_SPEED);
            nav.state = resume_state;
        }
        else
        {
            // 在保持半径内，停止电机
            Motor_Stop_All();
            nav.turn_output = 0;
            nav.speed_output = 0;
            nav.cross_track_error_m = 0;
        }
    }
}
