'use strict';

/**
 * 导航实跑数据分析：把一次航程的遥测变成"下一次该改哪个参数"的判断。
 *
 * 核心思路：PID 的作用是压住风和水流造成的航向偏移，所以最关心的指标是
 *   ① 航向误差有多大、多久以内（pctWithin10 / meanAbsErr）
 *   ② 误差是在收敛还是在振荡（零穿次数 + 周期 + 幅值）
 *   ③ 控制器有没有打满、积分有没有发散（satRatio + 长时饱和段）
 *   ④ 航向跟住了但船有没有贴住航线（cross-track）
 *
 * 每个结论都必须带"证据"，不允许出现无依据的建议。
 */

const DEFAULT_TURN_LIMIT = 80; // NAV_MAX_TURN_SPEED

const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : +Number(v).toFixed(d));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function percentile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

/** 用 MCU 的 uptime 做时间轴，避免 LoRa 抖动污染 dt */
function timelineOf(samples) {
  const hasUptime = samples.every((s) => Number.isFinite(s.uptimeMs));
  const t0 = hasUptime ? samples[0].uptimeMs : samples[0].rxAt;
  return samples.map((s) => ((hasUptime ? s.uptimeMs : s.rxAt) - t0) / 1000); // 秒
}

/**
 * @param {object[]} samples decodeTelemetry 输出
 * @param {object} options { turnLimit, holdLimit, gains:{kp,ki,kd}, xgains:{kp,ki,kd} }
 */
function analyzeRun(samples, options = {}) {
  const turnLimit = Number(options.turnLimit) || DEFAULT_TURN_LIMIT;
  const all = Array.isArray(samples) ? samples : [];
  const navOnly = all.filter((s) => s.navState === 1);

  const report = {
    run: {
      totalFrames: all.length,
      navFrames: navOnly.length,
      holdingFrames: all.filter((s) => s.navState === 2).length,
      durationS: all.length > 1 ? round((all[all.length - 1].rxAt - all[0].rxAt) / 1000, 1) : 0
    },
    gains: options.gains || null,
    xgains: options.xgains || null,
    metrics: {},
    diagnosis: []
  };

  if (navOnly.length < 5) {
    report.diagnosis.push({
      severity: 'fail',
      title: '导航数据不足',
      detail: `只有 ${navOnly.length} 帧处于"导航中"(ns=1)，至少需要 5 帧`,
      action: '航程太短无法评估。把目标设远一些（≥15m），或降低 --arrive 让船多跑一段。'
    });
    return report;
  }

  const ts = timelineOf(navOnly);
  const err = navOnly.map((s) => s.headingErrorDeg).filter((v) => Number.isFinite(v));
  const absErr = err.map(Math.abs);
  const turn = navOnly.map((s) => s.turnOutput).filter((v) => Number.isFinite(v));
  const absTurn = turn.map(Math.abs);
  const dist = navOnly.map((s) => s.distanceM).filter((v) => Number.isFinite(v));
  const xt = navOnly.map((s) => s.crossTrackM).filter((v) => Number.isFinite(v));
  const lw = navOnly.map((s) => s.leftPwm).filter((v) => Number.isFinite(v));
  const rw = navOnly.map((s) => s.rightPwm).filter((v) => Number.isFinite(v));

  const navDurationS = ts[ts.length - 1] - ts[0];

  // ---------- ① 航向跟踪 ----------
  const pctWithin = (lim) => round(absErr.filter((v) => v <= lim).length / absErr.length, 3);
  report.metrics.tracking = {
    samples: absErr.length,
    durationS: round(navDurationS, 1),
    meanAbsErrDeg: round(mean(absErr)),
    p95AbsErrDeg: round(percentile(absErr, 0.95)),
    maxAbsErrDeg: round(Math.max(...absErr)),
    pctWithin5: pctWithin(5),
    pctWithin10: pctWithin(10),
    pctWithin20: pctWithin(20)
  };

  // ---------- ② 振荡 ----------
  // 用 2° 死区判断符号变化，避免噪声制造假零穿
  const DEADBAND = 2;
  const crossings = [];
  let lastSign = 0;
  for (let i = 0; i < err.length; i += 1) {
    if (Math.abs(err[i]) < DEADBAND) continue;
    const sign = Math.sign(err[i]);
    if (lastSign !== 0 && sign !== lastSign) crossings.push({ idx: i, sign });
    lastSign = sign;
  }

  // 同向相邻零穿之间是半个周期
  const halfPeriods = [];
  for (let i = 2; i < crossings.length; i += 1) {
    const dt = ts[crossings[i].idx] - ts[crossings[i - 2].idx];
    if (dt > 0) halfPeriods.push(dt);
  }
  const periodS = halfPeriods.length ? round(mean(halfPeriods), 2) : null;

  // 峰峰值：每次零穿之后到下一次零穿之前的最大 |e|
  const lobes = [];
  for (let i = 0; i < crossings.length - 1; i += 1) {
    const a = crossings[i].idx;
    const b = crossings[i + 1].idx;
    lobes.push(Math.max(...absErr.slice(a, b + 1)));
  }
  const oscillationAmplitude = lobes.length ? round(mean(lobes)) : null;

  report.metrics.oscillation = {
    zeroCrossings: crossings.length,
    periodS,
    amplitudeDeg: oscillationAmplitude,
    crossingsPerSec: navDurationS > 0 ? round(crossings.length / navDurationS, 3) : null
  };

  // ---------- ③ 控制输出 ----------
  const satCount = absTurn.filter((v) => v >= turnLimit * 0.98).length;
  const satRatio = absTurn.length ? satCount / absTurn.length : 0;

  // 最长连续饱和段（秒）
  let longestSatS = 0;
  let streakStart = null;
  const satFlags = navOnly.map((s) => Math.abs(s.turnOutput || 0) >= turnLimit * 0.98);
  for (let i = 0; i < satFlags.length; i += 1) {
    if (satFlags[i] && streakStart === null) streakStart = i;
    if ((!satFlags[i] || i === satFlags.length - 1) && streakStart !== null) {
      const end = satFlags[i] ? i : i - 1;
      const dur = ts[end] - ts[streakStart];
      if (dur > longestSatS) longestSatS = dur;
      streakStart = null;
    }
  }

  report.metrics.control = {
    turnLimit,
    meanAbsTurn: round(mean(absTurn)),
    satRatio: round(satRatio, 3),
    longestSaturationS: round(longestSatS, 1),
    meanAbsLeftPwm: round(mean(lw.map(Math.abs))),
    meanAbsRightPwm: round(mean(rw.map(Math.abs))),
    pwmAsymmetry: (lw.length && rw.length)
      ? round(Math.abs(mean(lw.map(Math.abs)) - mean(rw.map(Math.abs))), 1)
      : null
  };

  // ---------- ④ 稳态（最后 25%）----------
  const tail = Math.max(1, Math.floor(err.length * 0.25));
  const tailErr = err.slice(-tail);
  report.metrics.steady = {
    samples: tail,
    signedMeanErrDeg: round(mean(tailErr)),
    absMeanErrDeg: round(mean(tailErr.map(Math.abs))),
    stdErrDeg: round(Math.sqrt(mean(tailErr.map((v) => (v - mean(tailErr)) ** 2))))
  };

  // ---------- ⑤ 收敛 ----------
  const SETTLE_BAND = 10;
  const SETTLE_HOLD_S = 5;
  let convergeS = null;
  for (let i = 0; i < absErr.length; i += 1) {
    const windowEnd = ts[i] + SETTLE_HOLD_S;
    const seg = absErr.filter((_, j) => ts[j] >= ts[i] && ts[j] <= windowEnd);
    if (seg.length >= 3 && seg.every((v) => v <= SETTLE_BAND)) {
      convergeS = round(ts[i], 1);
      break;
    }
  }
  report.metrics.convergence = { bandDeg: SETTLE_BAND, holdS: SETTLE_HOLD_S, convergedAtS: convergeS };

  // ---------- ⑥ 航迹贴合 ----------
  report.metrics.crosstrack = {
    samples: xt.length,
    rmsM: xt.length ? round(Math.sqrt(mean(xt.map((v) => v * v))), 2) : null,
    maxM: xt.length ? round(Math.max(...xt.map(Math.abs)), 2) : null
  };

  report.metrics.distance = {
    startM: dist.length ? round(dist[0], 1) : null,
    endM: dist.length ? round(dist[dist.length - 1], 1) : null
  };

  // ================= 诊断 =================
  const t = report.metrics.tracking;
  const o = report.metrics.oscillation;
  const c = report.metrics.control;
  const s = report.metrics.steady;
  const x = report.metrics.crosstrack;
  const g = options.gains || {};

  const push = (severity, title, detail, action) => report.diagnosis.push({ severity, title, detail, action });
  const scale = (v, f) => (Number.isFinite(Number(v)) ? round(Number(v) * f, 2) : null);

  // 振荡优先判断，因为它决定了后面所有建议的方向
  const isOscillating = o.zeroCrossings >= 6 && o.periodS !== null && o.periodS < 10 && (o.amplitudeDeg || 0) > 6;
  const isSlowSwing = o.zeroCrossings >= 4 && o.periodS !== null && o.periodS >= 10;

  if (isOscillating) {
    push('fail', '检测到高频振荡',
      `零穿 ${o.zeroCrossings} 次，周期约 ${o.periodS}s，摆幅约 ${o.amplitudeDeg}°`,
      `典型是比例增益过大。把 heading_pid.kp 从 ${g.kp ?? '当前值'} 降到 ${scale(g.kp, 0.7) ?? '×0.7'} 再来一次；若仍有小幅度抖动再降 kd。`);
  } else if (isSlowSwing) {
    push('warn', '检测到低频摆动',
      `零穿 ${o.zeroCrossings} 次，周期约 ${o.periodS}s`,
      `多为积分过强或阻尼不足。先把 kd 从 ${g.kd ?? '当前值'} 提到 ${scale(g.kd, 1.5) ?? '×1.5'}，仍有大周期漂移再降 ki。`);
  } else if (o.zeroCrossings <= 2) {
    push('ok', '没有明显振荡', `零穿 ${o.zeroCrossings} 次`);
  }

  if (t.pctWithin10 === null) {
    // 数据不足，跳过
  } else if (t.pctWithin10 < 0.6) {
    push('fail', '航向保持不达标',
      `只有 ${round(t.pctWithin10 * 100, 0)}% 的时间航向误差在 ±10° 内（目标 ≥ 80%），平均 ${t.meanAbsErrDeg}°，P95 ${t.p95AbsErrDeg}°`,
      '先解决振荡/饱和，再谈跟踪精度。这两项没改善前调 ki 没有意义。');
  } else if (t.pctWithin10 < 0.8) {
    push('warn', '航向保持勉强',
      `${round(t.pctWithin10 * 100, 0)}% 时间在 ±10° 内，平均 ${t.meanAbsErrDeg}°`,
      '可接受但不够稳。优先看下面的饱和/振荡项。');
  } else {
    push('ok', '航向保持良好',
      `${round(t.pctWithin10 * 100, 0)}% 时间在 ±10° 内，平均 ${t.meanAbsErrDeg}°，P95 ${t.p95AbsErrDeg}°`);
  }

  if (c.satRatio > 0.30) {
    push('fail', '转向输出长时间饱和',
      `${round(c.satRatio * 100, 0)}% 的样本 turn_output 达到限幅 ${c.turnLimit}，最长连续饱和 ${c.longestSaturationS}s`,
      `饱和时 PID 已经失去调节能力，靠的是限幅值。要么转向能力不足（电机校准/桨效），要么 kp 过大。先把 kp 调小验证，再检查左右电机是否对称（当前左右平均 PWM 差 ${c.pwmAsymmetry}）。`);
  } else if (c.satRatio > 0.10) {
    push('warn', '转向输出偶有饱和',
      `${round(c.satRatio * 100, 0)}% 的样本饱和，最长连续 ${c.longestSaturationS}s`);
  } else {
    push('ok', '控制输出有余量', `饱和占比 ${round(c.satRatio * 100, 0)}%，平均输出 ${c.meanAbsTurn}`);
  }

  if (Math.abs(s.signedMeanErrDeg || 0) > 8 && c.satRatio < 0.15) {
    push('warn', '存在稳态偏置',
      `末段平均航向误差 ${s.signedMeanErrDeg}°（有符号），且输出未饱和`,
      `这是典型的风/水流持续干扰，需要积分项去抵消。把 ki 从 ${g.ki ?? '当前值'} 提到 ${scale(g.ki, 1.6) ?? '×1.6'}。`);
  }

  if (x.rmsM !== null && x.rmsM > 3) {
    push('warn', '航迹贴合差',
      `横向偏差 RMS ${x.rmsM}m，最大 ${x.maxM}m`,
      `在航向已经能跟住的前提下，说明 crosstrack_pid 偏弱。把 crosstrack kp 从 ${g.xkp ?? '当前值'} 提到 ${scale(g.xkp, 1.4) ?? '×1.4'}。`);
  }

  if (report.metrics.convergence.convergedAtS === null) {
    push('warn', '整段航程未收敛',
      `航向误差始终没有连续 ${SETTLE_HOLD_S}s 保持在 ±${SETTLE_BAND}° 内`,
      '如果航程本来就很短（<20s）可忽略；否则说明控制器一直在追目标。');
  }

  const fails = report.diagnosis.filter((d) => d.severity === 'fail').length;
  const warns = report.diagnosis.filter((d) => d.severity === 'warn').length;
  report.summary = { fail: fails, warn: warns, ok: report.diagnosis.filter((d) => d.severity === 'ok').length };
  report.verdict = fails > 0 ? 'needs_work' : warns > 0 ? 'acceptable' : 'good';

  return report;
}

/** 简单 ASCII 曲线：航向误差（*）与转向输出（+） */
function renderPlot(samples, { width = 68, height = 9 } = {}) {
  const nav = samples.filter((s) => s.navState === 1 && Number.isFinite(s.headingErrorDeg));
  if (nav.length < 5) return '';
  const errs = nav.map((s) => s.headingErrorDeg);
  const turns = nav.map((s) => s.turnOutput || 0);
  const maxAbsErr = Math.max(5, ...errs.map(Math.abs));
  const maxAbsTurn = Math.max(1, ...turns.map(Math.abs));
  const half = Math.floor(height / 2);
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));

  const colOf = (i) => Math.min(width - 1, Math.round((i / (nav.length - 1)) * (width - 1)));
  const rowOf = (v, scale) => {
    const norm = Math.max(-1, Math.min(1, v / scale));
    return Math.round(half - norm * half);
  };

  // 中轴
  for (let c = 0; c < width; c += 1) grid[half][c] = '-';
  for (let i = 0; i < nav.length; i += 1) {
    const r = rowOf(errs[i], maxAbsErr);
    grid[r][colOf(i)] = 'o';
  }
  for (let i = 0; i < nav.length; i += 1) {
    const r = rowOf(turns[i], maxAbsTurn);
    if (grid[r][colOf(i)] === ' ' || grid[r][colOf(i)] === '-') grid[r][colOf(i)] = '+';
  }

  const lines = grid.map((row) => '  |' + row.join(''));
  lines.push('  +' + '-'.repeat(width));
  lines.push('   o = 航向误差 (\u00b1' + maxAbsErr.toFixed(0) + '\u00b0)   + = 转向输出 (\u00b1' + maxAbsTurn.toFixed(0) + ')   左=起点 右=终点');
  return lines.join('\n');
}

function renderReport(report, { color = true, samples = null, plot = false } = {}) {
  const paint = (sev, text) => {
    if (!color) return text;
    const code = { fail: 31, warn: 33, ok: 32 }[sev] || 0;
    return '\u001b[' + code + 'm' + text + '\u001b[0m';
  };
  const icon = { fail: ' FAIL ', warn: ' WARN ', ok: '  OK  ' };
  const out = [];
  const m = report.metrics;

  out.push('');
  out.push('  ===== 导航实跑分析 =====');
  out.push('  帧: ' + report.run.totalFrames + ' 总 / ' + report.run.navFrames + ' 导航中 / ' + report.run.holdingFrames + ' 保持');
  if (report.run.durationS) out.push('  时长: ' + report.run.durationS + ' 秒');
  if (report.gains) out.push('  航向增益: kp=' + report.gains.kp + ' ki=' + report.gains.ki + ' kd=' + report.gains.kd);
  if (report.xgains) out.push('  横向增益: kp=' + report.xgains.kp + ' ki=' + report.xgains.ki + ' kd=' + report.xgains.kd);

  if (!m.tracking) {
    out.push('');
    for (const d of report.diagnosis) {
      out.push('  ' + paint(d.severity, icon[d.severity]) + ' ' + d.title);
      if (d.detail) out.push('          ' + d.detail);
      if (d.action) out.push('          → ' + d.action);
    }
    out.push('');
    return out.join('\n');
  }

  out.push('');
  out.push('  航向跟踪     平均 ' + m.tracking.meanAbsErrDeg + '°  P95 ' + m.tracking.p95AbsErrDeg
    + '°  最大 ' + m.tracking.maxAbsErrDeg + '°'
    + '   |   ±10°内 ' + (m.tracking.pctWithin10 * 100).toFixed(0) + '%');
  out.push('  振荡         零穿 ' + m.oscillation.zeroCrossings + ' 次'
    + (m.oscillation.periodS ? '  周期 ' + m.oscillation.periodS + 's  摆幅 ' + m.oscillation.amplitudeDeg + '°' : ''));
  out.push('  控制输出     平均 ' + m.control.meanAbsTurn + '  饱和 ' + (m.control.satRatio * 100).toFixed(0) + '%'
    + '  最长饱和 ' + m.control.longestSaturationS + 's'
    + '   |   左/右 PWM 均值 ' + m.control.meanAbsLeftPwm + ' / ' + m.control.meanAbsRightPwm);
  out.push('  稳态(末25%)  有符号均值 ' + m.steady.signedMeanErrDeg + '°  绝对均值 ' + m.steady.absMeanErrDeg + '°  标准差 ' + m.steady.stdErrDeg + '°');
  out.push('  横向偏差     RMS ' + m.crosstrack.rmsM + 'm  最大 ' + m.crosstrack.maxM + 'm');
  out.push('  收敛         ' + (m.convergence.convergedAtS === null ? '未在 ±10° 内稳定 5s' : '第 ' + m.convergence.convergedAtS + 's 起稳定'));

  if (plot && samples) {
    const art = renderPlot(samples);
    if (art) { out.push(''); out.push(art); }
  }

  out.push('');
  out.push('  ----- 诊断 -----');
  for (const d of report.diagnosis) {
    out.push('  ' + paint(d.severity, icon[d.severity]) + ' ' + d.title);
    if (d.detail) out.push('          ' + d.detail);
    if (d.action) out.push('          → ' + d.action);
  }
  out.push('');
  out.push('  结论: ' + ({ good: '参数可用', acceptable: '可用但有隐患', needs_work: '需要调整' }[report.verdict] || report.verdict));
  out.push('');
  return out.join('\n');
}

module.exports = { analyzeRun, renderReport, renderPlot, DEFAULT_TURN_LIMIT };
