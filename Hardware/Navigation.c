#include "Navigation.h"
#include "GPS.h"
#include "IMU901.h"
#include "Motor.h"
#include <math.h>
#include <string.h>

#define EARTH_RADIUS 6371000.0f  // 地球半径(米)
#define NAV_MIN_RADIUS_M 0.5f
#define NAV_MAX_RADIUS_M 200.0f
#define NAV_CROSS_TRACK_LIMIT_DEG 30.0f
#define NAV_FINAL_APPROACH_M 10.0f

Navigation_t nav;

/* 区域保持的积分项。P 控制在恒定水流下必然有稳态偏差（船停在
 * "推力刚好等于水流"的距离上），积分把它消掉。 */
static float hold_integral = 0.0f;

/* IMU 偏航角方向。
 *
 * 目标方位角按罗盘约定（0=北，顺时针为正）。如果模块的 yaw 是逆时针增大，
 * 这里置 -1 把它镜像过来。方向反了船会朝目标的反方向掉头。
 * 运行时可改（下行 {"t":"pid","ys":-1}），水上发现不对能立刻纠正。 */
static int8_t nav_yaw_sign = 1;

/* --- 航向保持测试（室内调内环，不需要 GPS）--- */
static NavHeadingMetrics_t hdg_metrics;
static float    hdg_elapsed_s;
static float    hdg_in_band_s;
static float    hdg_prev_err;
static float    hdg_err_sq_sum;
static int16_t  hdg_test_speed = 18;

static void Navigation_ResetPidState(void)
{
    heading_pid.integral = 0;
    heading_pid.prev_error = 0;
    heading_pid.prev_derivative = 0;
    heading_pid.primed = 0;
    crosstrack_pid.integral = 0;
    crosstrack_pid.prev_error = 0;
    crosstrack_pid.prev_derivative = 0;
    crosstrack_pid.primed = 0;
}

static void NavHeadingMetricsReset(void)
{
    memset(&hdg_metrics, 0, sizeof(hdg_metrics));
    hdg_metrics.settle_time_s = -1.0f;
    hdg_elapsed_s = 0.0f;
    hdg_in_band_s = 0.0f;
    hdg_prev_err = 0.0f;
    hdg_err_sq_sum = 0.0f;
}

static void NavHeadingMetricsUpdate(float dt_s)
{
    float e = nav.heading_error;
    float sign;
    float over;

    if (hdg_metrics.samples == 0)
    {
        hdg_metrics.step_deg = e;
        hdg_prev_err = e;
    }

    hdg_metrics.samples++;
    hdg_metrics.target_deg = nav.target_heading;
    hdg_metrics.current_deg = nav.target_heading - e;
    hdg_metrics.err_deg = e;

    /* 过冲：误差跑到阶跃方向的反面，取最大幅度 */
    sign = (hdg_metrics.step_deg >= 0.0f) ? 1.0f : -1.0f;
    over = -e * sign;
    if (over > hdg_metrics.overshoot_deg) hdg_metrics.overshoot_deg = over;

    /* 过零次数 */
    if (hdg_metrics.samples > 1 &&
        ((hdg_prev_err > 0.0f && e < 0.0f) || (hdg_prev_err < 0.0f && e > 0.0f)))
    {
        hdg_metrics.crossings++;
    }
    hdg_prev_err = e;

    /* 进入 ±10° 并保持 1 秒 = 收敛 */
    if (fabsf(e) < 10.0f)
    {
        hdg_in_band_s += dt_s;
        if (hdg_in_band_s >= 1.0f && hdg_metrics.settle_time_s < 0.0f)
        {
            hdg_metrics.settle_time_s = hdg_elapsed_s - 1.0f;
        }
    }
    else
    {
        hdg_in_band_s = 0.0f;
    }

    hdg_err_sq_sum += e * e;
    hdg_metrics.rms_err_deg = sqrtf(hdg_err_sq_sum / (float)hdg_metrics.samples);
    hdg_elapsed_s += dt_s;
}

void Navigation_StartHeadingTest(float deg, int16_t speed)
{
    nav.target_heading = Navigation_NormalizeAngle(deg);
    hdg_test_speed = (speed > 0 && speed <= 100) ? speed : 18;
    nav.state = NAV_HEADING_TEST;
    nav.hold_active = 0;
    hold_integral = 0.0f;
    NavHeadingMetricsReset();
    Navigation_ResetPidState();
    Motor_Stop_All();
}

void Navigation_GetHeadingMetrics(NavHeadingMetrics_t *out)
{
    if (out) *out = hdg_metrics;
}

void Navigation_SetYawSign(int8_t sign)
{
    nav_yaw_sign = (sign < 0) ? -1 : 1;
}

int8_t Navigation_GetYawSign(void)
{
    return nav_yaw_sign;
}
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

void PID_Init(PID_t *pid, float kp, float ki, float kd,
              float integral_limit, float output_limit, float derivative_filter)
{
    pid->kp = kp;
    pid->ki = ki;
    pid->kd = kd;
    pid->integral = 0;
    pid->prev_error = 0;
    pid->prev_derivative = 0;
    pid->integral_limit = integral_limit;
    pid->output_limit = output_limit;
    pid->derivative_filter = (derivative_filter < 0.0f) ? 0.0f
                           : (derivative_filter > 0.95f) ? 0.95f
                           : derivative_filter;
    pid->primed = 0;
}

float PID_Calculate(PID_t *pid, float error, float dt_s)
{
    float p, d, output;
    float raw_derivative;

    // 时间步长钳位：首帧、调度抖动、主循环被阻塞后都不能让微分项爆掉
    if (dt_s < 0.01f) dt_s = 0.01f;
    if (dt_s > 0.50f) dt_s = 0.50f;

    // 首帧预置：把 prev_error 对齐到当前误差，否则 (error-0)/dt 会产生巨大导数冲击，
    // 表现是刚启动导航瞬间电机打满、船原地甩头。
    if (!pid->primed)
    {
        pid->prev_error = error;
        pid->prev_derivative = 0.0f;
        pid->primed = 1u;
    }

    // 比例
    p = pid->kp * error;

    // 微分：先差分再一阶低通，抑制 GPS/IMU 抖动被 1/dt 放大
    raw_derivative = (error - pid->prev_error) / dt_s;
    pid->prev_derivative = pid->derivative_filter * pid->prev_derivative
                         + (1.0f - pid->derivative_filter) * raw_derivative;
    d = pid->kd * pid->prev_derivative;

    // 条件积分抗饱和：输出未饱和时才累积
    output = p + pid->ki * pid->integral + d;
    if ((output < pid->output_limit) && (output > -pid->output_limit))
    {
        pid->integral += error * dt_s;

        if (pid->integral > pid->integral_limit)
            pid->integral = pid->integral_limit;
        if (pid->integral < -pid->integral_limit)
            pid->integral = -pid->integral_limit;
    }

    pid->prev_error = error;

    output = p + pid->ki * pid->integral + d;

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
    crosstrack_pid.prev_derivative = 0;
    crosstrack_pid.primed = 0;
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
    nav.hold_active = 0;
    hold_integral = 0.0f;
    nav.boundary_distance_m = 0;
    nav.return_distance_m = 0;
    Navigation_ResetLeg();

    /* 航向 PID（量纲按 20Hz 标定，dt 由 Navigation_Update 实测传入）
     *   kp = 2.0      PWM/dag      : 偏 1 度给 2 个 PWM，40 度打满
     *   ki = 0.35     PWM/(dag*s)  : 抵消持续侧风/水流造成的固定偏差
     *   kd = 0.25     PWM/(dag/s)  : 抑制转向超调
     *   integral_limit = 60        : 积分最多贡献 0.35*60 = 21 PWM
     *   derivative_filter = 0.7    : 微分一阶低通，滤掉 IMU 抖动
     */
    /* 实测修正：原来 kp=2.0 + 上限 80，航向误差超过 40° 就饱和，
     * 低于 40° 才有比例调节。水上实测船原地打转，转向输出长期 ±80。
     * 改成 kp=0.8 + 上限 45：误差 30° -> 24，10° -> 8，全程有比例调节。
     * ki 先留 0（大误差下积分会顶到上限、加剧打转），kd=0.3 提供阻尼。 */
    PID_Init(&heading_pid, 0.8f, 0.0f, 0.30f, 60.0f, (float)NAV_HEADING_TURN_LIMIT, 0.7f);

    /* 横向偏差 PID（输入=米，输出=航向修正角）
     *   kp = 2.3      dag/m       : 偏 1 米修 2.3 度
     *   ki = 0.30     dag/(m*s)   : 消除侧流导致的持续横偏
     *   kd = 0.12     dag/(m/s)
     *   output_limit = 30 度      : 横偏修正不应喧宾夺主
     */
    PID_Init(&crosstrack_pid, 2.3f, 0.30f, 0.12f, 40.0f, NAV_CROSS_TRACK_LIMIT_DEG, 0.7f);
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
        heading_pid.prev_derivative = 0;
        heading_pid.primed = 0;
        crosstrack_pid.integral = 0;
        crosstrack_pid.prev_error = 0;
        crosstrack_pid.prev_derivative = 0;
        crosstrack_pid.primed = 0;
        Navigation_UpdateLegStart();
    }
}

void Navigation_SetPid(float hkp, float hki, float hkd,
                       float xkp, float xki, float xkd)
{
    /* 只更新提供的项（<=0 = 未提供），并钳位防止上位机写坏参数 */
    if (hkp > 0.0f && hkp <= 50.0f)  heading_pid.kp = hkp;
    if (hki >= 0.0f && hki <= 20.0f) heading_pid.ki = hki;
    if (hkd >= 0.0f && hkd <= 50.0f) heading_pid.kd = hkd;

    if (xkp > 0.0f && xkp <= 50.0f)  crosstrack_pid.kp = xkp;
    if (xki >= 0.0f && xki <= 20.0f) crosstrack_pid.ki = xki;
    if (xkd >= 0.0f && xkd <= 50.0f) crosstrack_pid.kd = xkd;

    /* 换参数后旧的积分/微分状态不再适用 */
    heading_pid.integral = 0;
    heading_pid.prev_error = 0;
    heading_pid.prev_derivative = 0;
    heading_pid.primed = 0;

    crosstrack_pid.integral = 0;
    crosstrack_pid.prev_error = 0;
    crosstrack_pid.prev_derivative = 0;
    crosstrack_pid.primed = 0;
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

static float Navigation_CrossTrackHeading(float current_lat, float current_lon, float dt_s)
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
    /* 原来这里是「固定比例 + PID」叠加在同一个误差上，等效比例增益被算了两遍，
     * 而且积分/微分也跟比例项混在一起，无法单独整定。现在只保留 PID。 */
    correction = PID_Calculate(&crosstrack_pid, -cross_track, dt_s);
    correction = Navigation_ClampFloat(correction, -NAV_CROSS_TRACK_LIMIT_DEG, NAV_CROSS_TRACK_LIMIT_DEG);

    // 临近目标时逐步切回直达目标，避免为贴线而绕过目标点
    blend = Navigation_ClampFloat(nav.distance / NAV_FINAL_APPROACH_M, 0.0f, 1.0f);
    nav.corrected_heading = Navigation_NormalizeAngle(direct_heading + correction * blend);
    return nav.corrected_heading;
}

// 导航更新函数，在主循环中周期性调用
// 内部：执行导航/保持的电机输出
static void Navigation_DriveHeading(float desired_heading, float current_yaw, int16_t base_speed, float dt_s)
{
    int16_t left_speed, right_speed;

    nav.target_heading = Navigation_NormalizeAngle(desired_heading);

    // 计算航向误差（归一化到 -180 ~ 180）
    /* 按标定方向把当前偏航角折算成罗盘约定 */
    nav.heading_error = Navigation_NormalizeAngle(
        nav.target_heading - current_yaw * (float)nav_yaw_sign);

    // PID计算转向输出（带真实时间步长）
    nav.turn_output = (int16_t)PID_Calculate(&heading_pid, nav.heading_error, dt_s);

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

static void Navigation_DriveToPoint(float current_lat, float current_lon, float current_yaw, float target_lat, float target_lon, int16_t base_speed, float dt_s)
{
    Navigation_DriveHeading(Navigation_CalcBearing(current_lat, current_lon, target_lat, target_lon), current_yaw, base_speed, dt_s);
}

void Navigation_Update(void)
{
    static uint32_t last_tick = 0;
    uint32_t now_tick;
    float dt_s;
    float current_lat, current_lon, current_yaw, desired_heading;

    /* 真实时间步长：PID 的积分/微分都依赖它。
     * 首帧按 50ms 估；即使中间被别的任务拖慢，dt 也会在 PID 内部钳位。 */
    now_tick = HAL_GetTick();
    dt_s = (last_tick == 0) ? 0.05f : (float)(now_tick - last_tick) / 1000.0f;
    last_tick = now_tick;

    if (nav.state == NAV_IDLE)
    {
        return;
    }

    /* 航向保持测试：不需要 GPS，只用陀螺仪 + 电机
     * 室内调内环（航向 PID）就靠这个模式。 */
    if (nav.state == NAV_HEADING_TEST)
    {
        current_yaw = IMU901_GetYaw();
        Navigation_DriveHeading(nav.target_heading, current_yaw,
                                hdg_test_speed, dt_s);
        NavHeadingMetricsUpdate(dt_s);
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
                                nav.boundary_center_lat, nav.boundary_center_lon, NAV_HOLD_SPEED, dt_s);
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
            nav.hold_active = 0;
            hold_integral = 0.0f;
            Motor_Stop_All();
            return;
        }

        desired_heading = Navigation_CrossTrackHeading(current_lat, current_lon, dt_s);
        Navigation_DriveHeading(desired_heading, current_yaw, NAV_BASE_SPEED, dt_s);
    }
    else if (nav.state == NAV_HOLDING)
    {
        /* 区域保持。
         *
         * 语义是"待在这个区域里"，不是"钉在目标点上"——
         * GPS 静差 2~5 米，守点只会在噪声里来回抖。
         *
         *   半径内            -> 不管，随便漂（这就是区域）
         *   超过 半径×0.8     -> 开始往回拉
         *   拉回到 半径×0.45  -> 停桨，留余量再漂
         *
         * 旧实现只在 > drift_radius(8m) 才动、一进 8m 就停桨，
         * 平衡点永远落在 8 米边界上，就是"漂流瓶"。
         */
        float area = (nav.hold_radius_m > NAV_HOLD_DEADBAND_MIN)
                   ? nav.hold_radius_m : NAV_HOLD_DEADBAND_MIN;
        float release = area * NAV_HOLD_RELEASE_RATIO;
        float err = nav.distance - release;
        float speed_f;

        if (err < 0.0f) err = 0.0f;

        /* 迟滞：误差超过 ON 才动手，低于 OFF 才停手。
         * 没有迟滞时电机会以每秒十几次的频率启停。 */
        if (!nav.hold_active && err > NAV_HOLD_ON_M)
        {
            nav.hold_active = 1;
        }
        else if (nav.hold_active && err < NAV_HOLD_OFF_M)
        {
            nav.hold_active = 0;
        }

        if (nav.hold_active)
        {
            hold_integral += err * NAV_HOLD_KI * dt_s;
            if (hold_integral > NAV_HOLD_INT_LIMIT) hold_integral = NAV_HOLD_INT_LIMIT;
            if (hold_integral < 0.0f) hold_integral = 0.0f;

            speed_f = (float)NAV_HOLD_MIN_SPEED + NAV_HOLD_KP * err + hold_integral;
            if (speed_f > (float)NAV_HOLD_MAX_SPEED) speed_f = (float)NAV_HOLD_MAX_SPEED;

            /* 朝目标点走，用航向 PID 稳住船头 */
            Navigation_DriveHeading(
                Navigation_CalcBearing(current_lat, current_lon, nav.target_lat, nav.target_lon),
                current_yaw, (int16_t)speed_f, dt_s);
        }
        else
        {
            hold_integral *= NAV_HOLD_INT_DECAY;

            Motor_Stop_All();
            nav.turn_output = 0;
            nav.speed_output = 0;
            nav.cross_track_error_m = 0;
        }
    }
}
