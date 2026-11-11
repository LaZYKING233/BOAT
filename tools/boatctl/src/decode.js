'use strict';

/**
 * 遥测解码：把固件发来的定点整数还原成带单位的人类可读值。
 *
 * 固件协议见 README.md「通信协议」一节。所有 *100 缩放的字段在这里除回去，
 * 原始值保留在 raw 里，分析时两边都能用。
 */

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const div = (v, d) => { const n = num(v); return n === null ? null : n / d; };
const flag = (v) => (v === undefined || v === null ? null : Number(v) === 1);

const NAV_STATE = { 0: 'idle', 1: 'navigating', 2: 'holding', 3: 'no_gps', 4: 'returning' };
const BOUNDARY_STATE = { 0: 'disabled', 1: 'inside', 2: 'margin', 3: 'outside' };
const RETURN_STATE = { 0: 'none', 1: 'active', 2: 'recovered' };

/**
 * @param {object} raw 固件原始 data 报文
 * @param {number} rxAt 本地接收时间戳(ms)
 */
function decodeTelemetry(raw, rxAt) {
  if (!raw || raw.t !== 'data') return null;

  const fix = num(raw.fix) || 0;
  const lat = div(raw.lat, 1e7);
  const lon = div(raw.lon, 1e7);

  return {
    // ---- 基础 ----
    seq: num(raw.seq),
    uptimeMs: num(raw.ms),
    rxAt: rxAt || Date.now(),

    // ---- 水质 ----
    ph: div(raw.ph, 100),
    phRaw: num(raw.phr),
    phMv: num(raw.phmv),

    // ---- 温度 ----
    tempC: flag(raw.tv) ? div(raw.tc, 100) : null,
    tempRaw: div(raw.tc, 100),
    tempValid: flag(raw.tv),

    // ---- GPS ----
    fix,
    satellites: num(raw.sat) || 0,
    lat: fix > 0 ? lat : null,
    lon: fix > 0 ? lon : null,

    // ---- IMU ----
    imuValid: flag(raw.iv),
    roll: div(raw.ir, 100),
    pitch: div(raw.ip, 100),
    yaw: div(raw.iy, 100),
    imuRxBytes: num(raw.ib),
    imuFrames: num(raw.ia),

    // ---- 导航 ----
    navState: num(raw.ns),
    navStateName: NAV_STATE[num(raw.ns)] || 'unknown',
    distanceM: num(raw.ns) > 0 ? div(raw.nd, 100) : null,
    headingErrorDeg: div(raw.nt, 100),
    boundaryState: num(raw.bs),
    boundaryStateName: BOUNDARY_STATE[num(raw.bs)] || 'unknown',
    boundaryDistanceM: div(raw.bd, 100),
    returnState: num(raw.rs),
    returnStateName: RETURN_STATE[num(raw.rs)] || 'unknown',
    returnDistanceM: div(raw.rd, 100),
    crossTrackM: div(raw.xt, 100),
    correctedHeadingDeg: div(raw.ch, 100),

    // ---- 控制输出（PID 整定必需：只看误差无法区分"增益过大"与"输出饱和"）----
    turnOutput: num(raw.to),
    leftPwm: num(raw.lw),
    rightPwm: num(raw.rw),

    // ---- 当前生效的 PID 增益（固件回传，保证数据自带参数）----
    headingGains: { kp: div(raw.hk, 1000), ki: div(raw.hi, 1000), kd: div(raw.hd, 1000) },
    crosstrackGains: { kp: div(raw.xk, 1000), ki: div(raw.xi, 1000), kd: div(raw.xd, 1000) },

    // ---- 边缘 AI ----
    // 返回码 0 = OK，-1 = 尚未调用。用来区分"模型没初始化成功"
    // 与"输入偏离训练分布"——两者处理方式完全相反。
    aiPhInitState: num(raw.api),
    aiPhDetectState: num(raw.apd),
    aiTempInitState: num(raw.ati),
    aiTempDetectState: num(raw.atd),
    aiPhSimilarity: num(raw.aiph),
    aiPhNormal: flag(raw.aiphn),
    aiTempSimilarity: num(raw.ait),
    aiTempNormal: flag(raw.aitn),

    // ---- 电机校准 ----
    motorLeftScale: div(raw.mls, 100),
    motorRightScale: div(raw.mrs, 100),
    motorLeftOffset: num(raw.mlo),
    motorRightOffset: num(raw.mro),
    motorLeftDeadzone: num(raw.mlz),
    motorRightDeadzone: num(raw.mrz),

    // ---- 接收计数 ----
    gpsRxBytes: num(raw.gb),
    gpsLines: num(raw.gl),

    // ---- 原始报文 ----
    raw
  };
}

module.exports = { decodeTelemetry, NAV_STATE, BOUNDARY_STATE, RETURN_STATE };
