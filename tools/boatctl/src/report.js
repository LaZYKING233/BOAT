'use strict';

const fs = require('fs');
const path = require('path');
const { lineChart, esc } = require('./chart');

/**
 * 把一次实跑变成两份产物：
 *   <run>.json  结构化数据，给报告/论文/后续分析用
 *   <run>.html  单文件可视化，离线可开、可直接打印成 PDF
 */

const round2 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : +Number(v).toFixed(2));

/** 展开的航向对：把 -180..180 的跳变消掉，否则船过正北时曲线会炸 */
function unwrapYaw(samples) {
  const yaw = [];
  const target = [];
  let prevYaw = null;

  for (const s of samples) {
    if (s.yaw === null || s.yaw === undefined) { yaw.push(null); target.push(null); continue; }

    let y = Number(s.yaw);
    if (prevYaw !== null) {
      while (y - prevYaw > 180) y -= 360;
      while (y - prevYaw < -180) y += 360;
    }
    prevYaw = y;
    yaw.push(y);

    const ch = s.correctedHeadingDeg;
    if (ch === null || ch === undefined) { target.push(null); continue; }
    // 目标航向拉到与实际航向同一分支，两条线才可比
    let t = Number(ch);
    while (t - y > 180) t -= 360;
    while (t - y < -180) t += 360;
    target.push(t);
  }

  return { yaw, target };
}

function buildSeries(samples) {
  const { yaw, target } = unwrapYaw(samples);
  const useUptime = samples.every((s) => Number.isFinite(s.uptimeMs));
  const t0 = useUptime ? samples[0].uptimeMs : samples[0].rxAt;

  return samples.map((s, i) => ({
    t: round2(((useUptime ? s.uptimeMs : s.rxAt) - t0) / 1000),
    targetYaw: round2(target[i]),
    yaw: round2(yaw[i]),
    err: round2(s.headingErrorDeg),
    turn: s.turnOutput === null || s.turnOutput === undefined ? null : Math.round(s.turnOutput),
    leftPwm: s.leftPwm === null || s.leftPwm === undefined ? null : Math.round(s.leftPwm),
    rightPwm: s.rightPwm === null || s.rightPwm === undefined ? null : Math.round(s.rightPwm),
    distM: round2(s.distanceM),
    crossTrackM: round2(s.crossTrackM),
    navState: s.navState
  }));
}

/**
 * @param {object[]} samples
 * @param {object} meta  来自 navrun 的元数据
 * @param {object} analysis  来自 analyzeRun
 */
function buildReport(samples, meta, analysis) {
  const series = buildSeries(samples);
  const gains = {
    heading: meta.gains || null,
    crosstrack: meta.xgains || null
  };

  return {
    schema: 'boatctl.navrun/1',
    generatedAt: new Date().toISOString(),
    run: {
      id: meta.runId || null,
      startedAt: meta.startedAt || null,
      endedAt: meta.endedAt || null,
      stopReason: meta.stopReason || null,
      frames: samples.length,
      durationS: series.length ? series[series.length - 1].t : 0,
      note: meta.note || '',
      target: meta.target || null
    },
    gains,
    sampling: {
      // 实际帧间隔，论文里描述采样率时要用
      loopPeriodMs: series.length > 1
        ? round2(((series[series.length - 1].t - series[0].t) * 1000) / (series.length - 1))
        : null,
      source: 'STM32 遥测经 LoRa 回传'
    },
    metrics: analysis ? analysis.metrics : {},
    diagnosis: analysis ? analysis.diagnosis : [],
    verdict: analysis ? analysis.verdict : null,
    series
  };
}

function points(series, key) {
  return series.filter((p) => p[key] !== null && p[key] !== undefined).map((p) => [p.t, p[key]]);
}

function card(label, value, hint) {
  return '<div class="card"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value)
    + '</div>' + (hint ? '<div class="h">' + esc(hint) + '</div>' : '') + '</div>';
}

function renderHtml(report) {
  const s = report.series || [];
  const m = report.metrics || {};
  const t = m.tracking || {};
  const o = m.oscillation || {};
  const c = m.control || {};
  const st = m.steady || {};
  const x = m.crosstrack || {};
  const cv = m.convergence || {};

  const charts = [];

  // ① 主图：陀螺仪目标航向 vs 实际航向
  charts.push(lineChart({
    width: 900, height: 300,
    title: '外环（角度环）：目标航向 vs 陀螺仪实测航向',
    series: [
      { name: '目标航向', color: '#2f6fb3', points: points(s, 'targetYaw'), width: 2, dash: '6 4' },
      { name: '实际航向', color: '#2f8f5b', points: points(s, 'yaw'), width: 2.2 }
    ],
    xLabel: '秒'
  }));

  // ② 内环误差
  charts.push(lineChart({
    width: 900, height: 220,
    title: '外环误差 = 目标航向 − 实测航向（阴影为 ±10° 目标带）',
    series: [{ name: '航向误差', color: '#b5651d', points: points(s, 'err'), width: 2 }],
    bands: [{ y0: -10, y1: 10, color: '#e8f5ee' }],
    hlines: [{ y: 10, color: '#9fc7ac', dash: '4 4' }, { y: -10, color: '#9fc7ac', dash: '4 4' }],
    xLabel: '秒'
  }));

  // ③ 控制输出
  charts.push(lineChart({
    width: 900, height: 240,
    title: '内环（PWM 执行级）：PID 转向量 → 左右电机实际 PWM',
    series: [
      { name: '转向输出', color: '#7b5ea7', points: points(s, 'turn'), width: 2.2 },
      { name: '左 PWM', color: '#9aa7b1', points: points(s, 'leftPwm'), width: 1.2 },
      { name: '右 PWM', color: '#c9b79c', points: points(s, 'rightPwm'), width: 1.2 }
    ],
    xLabel: '秒'
  }));

  // ④ 距离
  charts.push(lineChart({
    width: 900, height: 200,
    title: '到目标距离',
    series: [{ name: '距离', color: '#3f7f7f', points: points(s, 'distM'), width: 2 }],
    xLabel: '秒'
  }));

  const gainText = [];
  if (report.gains.heading) gainText.push('外环(角度) kp=' + report.gains.heading.kp + ' ki=' + report.gains.heading.ki + ' kd=' + report.gains.heading.kd);
  if (report.gains.crosstrack) gainText.push('横偏修正 kp=' + report.gains.crosstrack.kp + ' ki=' + report.gains.crosstrack.ki + ' kd=' + report.gains.crosstrack.kd);

  const diagHtml = (report.diagnosis || []).map((d) => {
    const cls = d.severity === 'fail' ? 'fail' : d.severity === 'warn' ? 'warn' : 'ok';
    return '<div class="diag ' + cls + '"><div class="dt"><span class="badge">' + esc(d.severity.toUpperCase()) + '</span>'
      + esc(d.title) + '</div>'
      + (d.detail ? '<div class="dd">' + esc(d.detail) + '</div>' : '')
      + (d.action ? '<div class="da">→ ' + esc(d.action) + '</div>' : '')
      + '</div>';
  }).join('');

  const css = [
    'body{margin:0;padding:24px 28px 60px;background:#fafafa;color:#222;font:14px/1.6 -apple-system,"Segoe UI","Noto Sans SC",sans-serif}',
    'h1{font-size:20px;margin:0 0 4px}',
    '.sub{color:#777;font-size:12px;margin-bottom:18px}',
    '.cards{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:18px}',
    '.card{background:#fff;border:1px solid #e6e6e6;border-radius:8px;padding:10px 14px;min-width:132px}',
    '.card .k{color:#888;font-size:11px}',
    '.card .v{font-size:19px;font-weight:600;margin-top:2px}',
    '.card .h{color:#999;font-size:10px;margin-top:2px}',
    'section.chart{background:#fff;border:1px solid #e6e6e6;border-radius:8px;padding:8px 10px 4px;margin-bottom:14px;overflow-x:auto}',
    '.diag{background:#fff;border:1px solid #e6e6e6;border-left-width:4px;border-radius:6px;padding:8px 12px;margin-bottom:8px}',
    '.diag.ok{border-left-color:#2f8f5b}.diag.warn{border-left-color:#c58a1a}.diag.fail{border-left-color:#b3372f}',
    '.badge{display:inline-block;font-size:10px;padding:1px 6px;border-radius:3px;margin-right:8px;color:#fff;background:#888}',
    '.diag.ok .badge{background:#2f8f5b}.diag.warn .badge{background:#c58a1a}.diag.fail .badge{background:#b3372f}',
    '.dd{color:#555;font-size:12px;margin-top:2px}',
    '.da{color:#2f6fb3;font-size:12px;margin-top:2px}',
    'footer{color:#999;font-size:11px;margin-top:24px}',
    '@media print{body{background:#fff}section.chart{break-inside:avoid}}'
  ].join('');

  const html = [];
  html.push('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">');
  html.push('<title>导航实跑报告 ' + esc(report.run.id || '') + '</title>');
  html.push('<style>' + css + '</style></head><body>');
  html.push('<h1>导航实跑报告</h1>');
  html.push('<div class="sub">' + esc(report.run.id || '')
    + ' · ' + esc(report.run.startedAt || '')
    + ' · ' + esc(String(report.run.frames)) + ' 帧 / ' + esc(String(report.run.durationS)) + ' 秒'
    + ' · 停止原因：' + esc(report.run.stopReason || '—') + '</div>');

  if (gainText.length) html.push('<div class="sub" style="color:#2f6fb3">本次增益：' + esc(gainText.join('　|　')) + '</div>');

  html.push('<section class="chart" style="padding:12px 16px">');
  html.push('<div style="font-size:13px;font-weight:600;margin-bottom:6px">控制结构</div>');
  html.push('<div style="font-size:12px;color:#555;line-height:1.9">');
  html.push('① <b>横偏修正环</b>：横向偏差(米) → 目标航向修正(度)。距目标 10m 内会线性淡出，'
    + '让船径直朝目标点而不是贴着航线绕过去。<br>');
  html.push('② <b>外环（角度环，闭环）</b>：目标航向 − 陀螺仪实测航向 → PID → 转向量 turn_output。<br>');
  html.push('③ <b>内环（PWM 执行级，开环）</b>：转向量 → 左右电机 PWM（含缩放、死区补偿、偏移）。<br>');
  html.push('<span style="color:#a06a1a">注意：内环没有电机转速/电流反馈（无编码器），所以它是开环映射，不是 PID。');
  html.push('执行级的非线性（死区、左右不对称、电池电压跌落）全部要由外环 PID 吸收，</span>');
  html.push('<span style="color:#a06a1a">这也是小指令不转、一过阈值就猛冲的根源。标定 <code>mcal</code> 的 scale/deadzone 就是在修这一层。</span>');
  html.push('</div></section>');

  html.push('<div class="cards">');
  html.push(card('±10° 内占比', t.pctWithin10 === undefined ? '—' : (t.pctWithin10 * 100).toFixed(0) + '%', '目标 ≥ 80%'));
  html.push(card('平均误差', (t.meanAbsErrDeg ?? '—') + '°', 'P95 ' + (t.p95AbsErrDeg ?? '—') + '°'));
  html.push(card('最大误差', (t.maxAbsErrDeg ?? '—') + '°'));
  html.push(card('振荡', o.zeroCrossings === undefined ? '—' : o.zeroCrossings + ' 次', o.periodS ? '周期 ' + o.periodS + 's' : '未检出周期'));
  html.push(card('输出饱和', c.satRatio === undefined ? '—' : (c.satRatio * 100).toFixed(0) + '%', '最长 ' + (c.longestSaturationS ?? '—') + 's'));
  html.push(card('稳态偏置', (st.signedMeanErrDeg ?? '—') + '°', '末段 25%'));
  html.push(card('横向 RMS', (x.rmsM ?? '—') + ' m'));
  html.push(card('收敛', cv.convergedAtS === null || cv.convergedAtS === undefined ? '未收敛' : cv.convergedAtS + ' s'));
  html.push('</div>');

  for (const c2 of charts) html.push('<section class="chart">' + c2 + '</section>');

  html.push('<h2 style="font-size:16px;margin:22px 0 10px">诊断</h2>');
  html.push(diagHtml || '<div class="dd">无</div>');

  html.push('<footer>数据来源：STM32 遥测经 LoRa 回传，约 1Hz。<br>');
  html.push('航向为目标值（外环输出）与 IMU 实际值的对比，已做 ±180° 展开处理。<br>');
  html.push('原始逐帧数据见同名 .json 文件。</footer>');
  html.push('</body></html>');

  return html.join('\n');
}

/** 写出 <base>.json 与 <base>.html */
function writeReportFiles(basePath, report) {
  fs.writeFileSync(basePath + '.json', JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(basePath + '.html', renderHtml(report), 'utf8');
  return { json: basePath + '.json', html: basePath + '.html' };
}

module.exports = { buildReport, renderHtml, writeReportFiles, buildSeries };
