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
#define NAV_HEADING_TURN_LIMIT 45   // 航向环转向输出上限
                                    // 原为 80，配合 kp=2.0 时航向误差 40° 就打满，
                                    // 船失去比例调节、只能全力自旋。45 既保留转向能力，
                                    // 又给"误差变小 -> 转向变小"留出空间。
#define NAV_HOLD_SPEED      30      // 保持/修正速度(PWM 0-100)
#define NAV_BOUNDARY_MARGIN 2.0f    // 默认边界容差(米)

/* 区域保持参数
 *
 * 语义是"守一个区域"，不是"守一个点"：GPS 静差本来就有 2~5 米，
 * 守点只会在噪声里来回抖。所以：
 *   - 在保持半径内：完全不管，随便漂（这就是"区域"）
 *   - 超出保持半径 × ARM_RATIO：开始往回拉
 *   - 拉回到保持半径 × RELEASE_RATIO：停桨，留出余量再漂
 *
 * ARM_RATIO 取 0.8 而不是 1.0：后端在距离超过保持半径时会暂停采样任务，
 * 提前一点开始修正，船就不会踩到那条线。
 */
#define NAV_HOLD_DEADBAND_MIN    1.0f   // 保持半径下限(米)
#define NAV_HOLD_RELEASE_RATIO   0.5f   // 收敛目标 = 保持半径 × 此系数
#define NAV_HOLD_ON_M            1.5f   // 误差超过此值开始修正(米)
#define NAV_HOLD_OFF_M           0.5f   // 误差低于此值停止修正(米)，迟滞防抖
#define NAV_HOLD_KP              4.0f   // 比例增益 (PWM / 米)
#define NAV_HOLD_KI              1.0f   // 积分增益 (PWM / (米·秒))，消除水流造成的稳态偏差
#define NAV_HOLD_MIN_SPEED       18     // 修正时的最小油门(PWM)
#define NAV_HOLD_MAX_SPEED       80     // 最大修正油门(PWM)
#define NAV_HOLD_INT_DECAY       0.998f // 停止修正时积分的泄放系数(每次调用)
#define NAV_HOLD_INT_LIMIT       80.0f  // 积分上限(PWM)

// 导航状态
typedef enum
{
    NAV_IDLE = 0,        // 空闲
    NAV_NAVIGATING,      // 导航中
    NAV_HOLDING,         // 区域保持/定点保持
    NAV_NO_GPS,          // GPS未定位
    NAV_RETURNING,       // 越界归位中
    NAV_HEADING_TEST,    // 航向保持测试（不依赖 GPS，室内调内环用）
} NavState_t;

// 边界状态
typedef enum
{
    NAV_BOUNDARY_DISABLED = 0,
    NAV_BOUNDARY_INSIDE = 1,
    NAV_BOUNDARY_MARGIN_ZONE = 2,
    NAV_BOUNDARY_OUTSIDE = 3,
} NavBoundaryState_t;

// 归位状态
typedef enum
{
    NAV_RETURN_NONE = 0,
    NAV_RETURN_ACTIVE = 1,
    NAV_RETURN_RECOVERED = 2,
} NavReturnState_t;

// PID参数结构体
typedef struct
{
    float kp;
    float ki;
    float kd;
    float integral;          // 积分项（已乘时间，单位：误差·秒）
    float prev_error;
    float prev_derivative;   // 低通后的微分值
    float integral_limit;
    float output_limit;
    float derivative_filter; // 0~1，越大越平滑；0 = 不平滑
    uint8_t primed;          // 0 = 尚未预置，首帧不产生导数冲击
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

    float arrive_radius_m;  // 到达半径(米)
    float hold_radius_m;    // 保持半径(米)
    float drift_radius_m;   // 漂移归位触发半径(米)

    uint8_t boundary_enabled;
    float boundary_center_lat;
    float boundary_center_lon;
    float boundary_length_m;
    float boundary_width_m;
    float boundary_margin_m;
    NavBoundaryState_t boundary_state;
    NavReturnState_t return_state;
    float boundary_distance_m;   // 正数=边界内最近距离，负数=越界距离
    float return_distance_m;     // 越界归位点距离(米)

    uint8_t hold_active;   // 定点保持是否正在修正（迟滞用）

    uint8_t leg_valid;
    float start_lat;
    float start_lon;
    float leg_bearing;
    float leg_distance;
    float cross_track_error_m;
    float corrected_heading;
} Navigation_t;

/**
 * @brief 航向保持测试的指标（阶跃响应用，调内环 PID 的依据）
 *
 * 目的：室内没有 GPS 也能调航向环。下发一个目标航向，船会原地转向并保持，
 * 固件同时统计这些指标，调参时不需要靠肉眼判断。
 */
typedef struct {
    float    target_deg;      // 目标航向
    float    current_deg;     // 当前航向
    float    err_deg;         // 当前误差
    float    step_deg;        // 阶跃幅度（首次误差，带符号）
    float    overshoot_deg;   // 过冲（朝反方向的最大幅度）
    float    settle_time_s;   // 进入 ±10° 并保持 1 秒的时间，-1 = 未收敛
    float    rms_err_deg;     // 误差 RMS
    uint16_t crossings;       // 误差过零次数（振荡次数的一半）
    uint32_t samples;         // 样本数
} NavHeadingMetrics_t;

extern Navigation_t nav;
extern PID_t heading_pid;
extern PID_t crosstrack_pid;

void Navigation_Init(void);
void Navigation_SetTarget(float lat, float lon);
void Navigation_SetMissionTarget(float lat, float lon,
                                 float arrive_radius_m, float hold_radius_m, float drift_radius_m,
                                 float boundary_center_lat, float boundary_center_lon,
                                 float boundary_length_m, float boundary_width_m, float boundary_margin_m);
void Navigation_Start(void);
void Navigation_Stop(void);

/**
 * @brief 进入航向保持测试模式（不需要 GPS）
 * @param deg   目标航向角（度，0=北，顺时针为正）
 * @param speed 基础推力 0-100，0 表示用默认值
 * @note  退出用 Navigation_Stop()。此模式下航向环正常工作，
 *        但速度被压得很低，适合室内原地观察转向。
 */
void Navigation_StartHeadingTest(float deg, int16_t speed);

/** 取当前航向测试的指标 */
void Navigation_GetHeadingMetrics(NavHeadingMetrics_t *out);

/**
 * @brief 设置 IMU 偏航角方向
 * @param sign +1 = yaw 顺时针增大（罗盘约定，0=北/90=东）；-1 = 逆时针增大
 * @note  目标方位角是按罗盘约定算的（顺时针为正）。若模块的 yaw 是逆时针
 *        增大，必须置 -1，否则航向误差符号相反，船会朝目标的反方向掉头。
 */
void Navigation_SetYawSign(int8_t sign);
int8_t Navigation_GetYawSign(void);

/**
 * @brief  运行时设置双层 PID 增益（上位机下发，免重新编译烧录）
 * @param  hkp/hki/hkd  内环：航向误差 -> 转向输出
 * @param  xkp/xki/xkd  外环：横向偏差 -> 目标航向修正角
 * @note   参数 <= 0 视为"本次不修改"；修改后会清除积分与微分状态，
 *         避免换参数后的第一拍带着旧状态产生冲击。
 */
void Navigation_SetPid(float hkp, float hki, float hkd,
                       float xkp, float xki, float xkd);
void Navigation_Update(void);
float Navigation_CalcDistance(float lat1, float lon1, float lat2, float lon2);
float Navigation_CalcBearing(float lat1, float lon1, float lat2, float lon2);
float Navigation_NormalizeAngle(float angle);

void PID_Init(PID_t *pid, float kp, float ki, float kd,
              float integral_limit, float output_limit, float derivative_filter);

/**
 * @brief  按真实时间步长计算 PID 输出
 * @param  pid     PID 实例
 * @param  error   当前误差（单位与 kp 匹配）
 * @param  dt_s    距上次调用的秒数，内部会钳到 [0.01, 0.5]
 * @note   带条件积分抗饱和：输出已饱和且误差同向时不再累积积分，
 *         避免长时间偏航后积分爆掉、回正时过冲。
 */
float PID_Calculate(PID_t *pid, float error, float dt_s);

#ifdef __cplusplus
}
#endif

#endif
