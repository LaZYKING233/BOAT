'use strict';

/**
 * 遥测分析：把一段采样窗口变成结构化结论。
 *
 * 判定阈值来自实际排障经验，集中在 THRESHOLDS 里，需要时可以单点调整。
 */

const THRESHOLDS = {
  // 主循环周期（固件 telemetry ms 字段的差值）
  loopIdealMin: 900,
  loopIdealMax: 1150,
  loopWarnMax: 1500,        // 超过这个值基本可以断定主循环被阻塞
  // 丢包
  seqGapWarnRatio: 0.02,
  seqGapFailRatio: 0.10,
  // pH ADC
  phRawMin: 200,
  phRawMax: 16300,
  // 有效性占比
  validOkRatio: 0.8,
  validWarnRatio: 0.2
};

const stats = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: +(sum / sorted.length).toFixed(2),
    median: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2)
  };
};

const round = (v, d = 2) => (v === null || v === undefined ? null : +Number(v).toFixed(d));

/**
 * @param {object[]} samples decodeTelemetry() 的输出序列
 */
function analyze(samples) {
  const verdicts = [];
  const add = (id, level, title, detail) => verdicts.push({ id, level, title, detail });

  if (!Array.isArray(samples) || samples.length === 0) {
    add('link', 'fail', '没有任何遥测帧', '检查 LoRa 接线、波特率，或 WebUI 的串口是否已连接');
    return { window: { packets: 0 }, verdicts, summary: { ok: 0, warn: 0, fail: 1 } };
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const windowMs = last.rxAt - first.rxAt;
  const packets = samples.length;
  const packetsPerSec = windowMs > 0 ? round((packets - 1) / (windowMs / 1000), 2) : null;

  // ---- 主循环周期 ----
  const loopDeltas = [];
  let reboots = 0;
  let seqGaps = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (cur.uptimeMs !== null && prev.uptimeMs !== null) {
      const d = cur.uptimeMs - prev.uptimeMs;
      if (d > 0 && d < 60000) loopDeltas.push(d);
      else if (d < 0) reboots += 1;
    }
    if (cur.seq !== null && prev.seq !== null) {
      const gap = cur.seq - prev.seq;
      if (gap > 1) seqGaps += gap - 1;
    }
  }

  const loop = stats(loopDeltas);
  const expectedPackets = packets + seqGaps;
  const gapRatio = expectedPackets > 0 ? seqGaps / expectedPackets : 0;

  // ---- 字段存活与变化 ----
  const tracked = {
    phRaw: (t) => t.phRaw,
    phMv: (t) => t.phMv,
    tempC: (t) => t.tempC,
    yaw: (t) => t.yaw,
    imuFrames: (t) => t.imuFrames,
    gpsRxBytes: (t) => t.gpsRxBytes,
    ph: (t) => t.ph,
    aiPhSimilarity: (t) => t.aiPhSimilarity
  };
  const fields = {};
  for (const [key, get] of Object.entries(tracked)) {
    const vals = samples.map(get).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)));
    const distinct = new Set(vals.map((v) => +Number(v).toFixed(3)));
    fields[key] = {
      present: vals.length,
      missing: packets - vals.length,
      distinct: distinct.size,
      min: vals.length ? round(Math.min(...vals)) : null,
      max: vals.length ? round(Math.max(...vals)) : null,
      last: vals.length ? round(vals[vals.length - 1]) : null
    };
  }

  // ---- 有效占比 ----
  const ratio = (pred) => round(samples.filter(pred).length / packets, 3);
  const tempValidRatio = ratio((t) => t.tempValid === true);
  const imuValidRatio = ratio((t) => t.imuValid === true);
  const gpsFixRatio = ratio((t) => Number(t.fix) > 0);

  // ================= 判定 =================

  // 链路
  add('link', 'ok', '收到遥测', `${packets} 帧 / ${round(windowMs / 1000, 1)} 秒`);

  // 主循环节奏：这是本项目历史上最致命的问题
  if (loop && loopDeltas.length >= 3) {
    if (loop.mean >= THRESHOLDS.loopIdealMin && loop.mean <= THRESHOLDS.loopIdealMax) {
      add('loop', 'ok', '主循环节奏正常', `周期均值 ${loop.mean}ms（目标 1000ms）`);
    } else if (loop.mean <= THRESHOLDS.loopWarnMax) {
      add('loop', 'warn', '主循环略慢', `周期均值 ${loop.mean}ms，最大 ${loop.max}ms。可能有阻塞源`);
    } else {
      add('loop', 'fail', '主循环被严重阻塞',
        `周期均值 ${loop.mean}ms（应为 1000ms）。导航 PID 在这个节奏下无法工作，先排查阻塞`);
    }
  } else if (packets > 1) {
    add('loop', 'warn', '主循环周期样本不足', '采集时间太短，建议至少 10 秒');
  }

  // 丢包
  if (gapRatio > THRESHOLDS.seqGapFailRatio) {
    add('seq', 'fail', '丢包严重', `seq 跳号 ${seqGaps} 帧（${round(gapRatio * 100, 1)}%），LoRa 链路或缓冲区有问题`);
  } else if (gapRatio > THRESHOLDS.seqGapWarnRatio) {
    add('seq', 'warn', '有丢包', `seq 跳号 ${seqGaps} 帧（${round(gapRatio * 100, 1)}%）`);
  } else {
    add('seq', 'ok', '帧序列连续', reboots > 0 ? `检测到 ${reboots} 次重启（seq 归零）` : '无跳号');
  }

  // pH
  const phRaw = fields.phRaw.last;
  if (phRaw === null || fields.phRaw.present === 0) {
    add('ph', 'fail', 'pH 无读数', 'phr 字段缺失，检查 PH.c 与 ADC 通道');
  } else if (phRaw === 0) {
    add('ph', 'fail', 'pH ADC 读数为 0', '电极未接、ADC 未启动，或通道配置错误');
  } else if (phRaw < THRESHOLDS.phRawMin || phRaw > THRESHOLDS.phRawMax) {
    add('ph', 'warn', 'pH ADC 读数超出常见范围', `phr=${phRaw}（常见 200~16300），确认探头是否接好`);
  } else {
    add('ph', 'ok', 'pH ADC 有读数', `phr=${phRaw}, phmv=${fields.phMv.last}mV, ph=${fields.ph.last}`);
  }

  // 温度
  if (tempValidRatio >= THRESHOLDS.validOkRatio) {
    add('temp', 'ok', '水温传感器正常', `有效占比 ${round(tempValidRatio * 100, 0)}%，当前 ${fields.tempC.last}℃`);
  } else if (tempValidRatio > 0) {
    add('temp', 'warn', '水温间歇有效', `有效占比 ${round(tempValidRatio * 100, 0)}%，检查 DS18B20 接线与 4.7k 上拉`);
  } else if (fields.tempC.present === 0) {
    add('temp', 'fail', '水温完全无读数', 'PB1 未接、上拉缺失，或探头损坏（固件已过滤 0x0550 = 85℃ 假值）');
  } else {
    add('temp', 'fail', '水温无效', 'tv 始终为 0');
  }

  // IMU
  const imuMoving = fields.imuFrames.distinct > 1;
  if (imuValidRatio >= THRESHOLDS.validOkRatio && imuMoving) {
    add('imu', 'ok', 'IMU 正在出数据', `帧计数 ${fields.imuFrames.min} → ${fields.imuFrames.max}，yaw=${fields.yaw.last}°`);
  } else if (imuValidRatio === 0) {
    add('imu', 'fail', 'IMU 无数据', 'USART2 波特率或接线问题；ib 有增长但 ia 不增长时多为 ATKP 帧校验不过');
  } else if (!imuMoving) {
    add('imu', 'warn', 'IMU 帧计数未变化', '可能刚上电，或模块没有持续输出');
  } else {
    add('imu', 'warn', 'IMU 间歇有效', `有效占比 ${round(imuValidRatio * 100, 0)}%`);
  }

  // GPS：室内无定位属预期，只 warn
  if (gpsFixRatio > 0) {
    add('gps', 'ok', 'GPS 已定位', `fix 占比 ${round(gpsFixRatio * 100, 0)}%，卫星 ${last.satellites}，位置 ${last.lat}, ${last.lon}`);
  } else if (fields.gpsRxBytes.distinct > 1) {
    add('gps', 'warn', 'GPS 有数据但未定位', `已收 ${fields.gpsRxBytes.last} 字节 / ${last.gpsLines} 条 NMEA；室内属正常，需到室外验证`);
  } else {
    add('gps', 'warn', 'GPS 无数据', 'UART4 未收到字节，检查接线与 38400 波特率');
  }

  // 边缘 AI
  if (fields.aiPhSimilarity.present > 0) {
    add('ai', 'ok', '端侧 AI 已接入', `pH 相似度 ${fields.aiPhSimilarity.last}，判为${last.aiPhNormal ? '正常' : '异常'}`);
  } else {
    add('ai', 'warn', '端侧 AI 未上报', 'aiph/aiphn 字段缺失，EdgeAI 可能初始化失败');
  }

  const summary = verdicts.reduce((acc, v) => { acc[v.level] += 1; return acc; }, { ok: 0, warn: 0, fail: 0 });

  return {
    window: {
      packets,
      durationMs: windowMs,
      packetsPerSec,
      startedAt: new Date(first.rxAt).toISOString(),
      endedAt: new Date(last.rxAt).toISOString()
    },
    loop,
    seq: { gaps: seqGaps, gapRatio: round(gapRatio, 4), reboots },
    fields,
    ratios: { tempValid: tempValidRatio, imuValid: imuValidRatio, gpsFix: gpsFixRatio },
    latest: {
      ph: last.ph, phRaw: last.phRaw, phMv: last.phMv,
      tempC: last.tempC, tempValid: last.tempValid,
      fix: last.fix, satellites: last.satellites, lat: last.lat, lon: last.lon,
      imuValid: last.imuValid, yaw: last.yaw,
      navState: last.navStateName, distanceM: last.distanceM,
      aiPhSimilarity: last.aiPhSimilarity, aiPhNormal: last.aiPhNormal
    },
    verdicts,
    summary
  };
}

/** 渲染成终端表格 */
function renderReport(report, { color = true } = {}) {
  const icon = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ' };
  const paint = (level, text) => {
    if (!color) return text;
    const code = { ok: 32, warn: 33, fail: 31 }[level] || 0;
    return `\u001b[${code}m${text}\u001b[0m`;
  };
  const lines = [];
  lines.push('');
  lines.push(`  窗口: ${report.window.packets} 帧 / ${round((report.window.durationMs || 0) / 1000, 1)} 秒   (${report.window.packetsPerSec || 0} 帧/秒)`);
  if (report.loop) {
    lines.push(`  主循环: 均值 ${report.loop.mean}ms  中位 ${report.loop.median}ms  P95 ${report.loop.p95}ms  最大 ${report.loop.max}ms`);
  }
  lines.push('');
  for (const v of report.verdicts) {
    lines.push(`  ${paint(v.level, icon[v.level])} ${v.title}`);
    if (v.detail) lines.push(`          ${v.detail}`);
  }
  lines.push('');
  const s = report.summary;
  lines.push(`  汇总: ${s.ok} 通过 / ${s.warn} 警告 / ${s.fail} 失败`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { analyze, renderReport, THRESHOLDS };
