#!/usr/bin/env node
'use strict';

const http = require('http');

/**
 * 任务模拟器：在没有任何硬件的情况下，把 WebUI 的 8 点巡检状态机完整跑一遍。
 *
 * 依赖 BOAT_SIM=1 启动的 WebUI（提供 /api/_bench/inject）。
 * 它会：
 *   1. 打开一个哑串口（写出去的字节没人收，只是为了让状态机能下发目标）
 *   2. 把采样参数调成秒级，缩短验证时间
 *   3. 下发目标，然后按"虚拟船"的位置持续注入遥测
 *   4. 观察 navigating -> stabilizing -> sampling -> 下一点 ... -> 完成
 */

const URL_BASE = process.env.BOAT_URL || 'http://127.0.0.1:3000';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(path, URL_BASE);
    const r = http.request({
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': payload.length } : {}) },
      timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
        if (res.statusCode >= 400) {
          const e = new Error((json && json.message) || ('HTTP ' + res.statusCode));
          e.statusCode = res.statusCode;
          reject(e);
        } else resolve(json);
      });
    });
    r.on('timeout', () => r.destroy(new Error('请求超时 ' + path)));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/* 恢复目标必须是确定值。之前用"读到的当前配置"作为原值，
 * 一旦上次运行被中断留下快参数，这次就会把快参数当成原值再写回去。 */
const DEFAULT_CONFIG = {
  arrivalRadiusM: 2,
  fallbackRadiusM: 6,
  boundaryMarginM: 4,
  returnRadiusM: 8,
  fallbackAfterMs: 30000,
  targetTimeoutMs: 180000,
  stabilizationMs: 10000,
  sampleIntervalMs: 2000,
  sampleDurationMs: 30000
};

const FAST_CONFIG = {
  arrivalRadiusM: 2,
  fallbackRadiusM: 8,
  boundaryMarginM: 12,
  returnRadiusM: 10,
  fallbackAfterMs: 5000,
  targetTimeoutMs: 60000,
  stabilizationMs: 2000,
  sampleIntervalMs: 1000,
  sampleDurationMs: 4000
};

const metersPerDegLat = 111320;
const mLonOf = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

let seq = 0;
let boat = null;

function makePayload(lat, lon, distanceM, navState, target) {
  const bearing = target
    ? (Math.atan2((target.longitude - lon) * mLonOf(lat), target.latitude - lat) * 180) / Math.PI
    : 0;
  const err = navState === 1 ? Math.max(-40, Math.min(40, bearing * 0.1)) : 0;
  const turn = navState === 1 ? Math.round(Math.max(-80, Math.min(80, 2.0 * err))) : 0;
  return {
    t: 'data', v: 1, seq: seq++,
    ms: 1000 + seq * 400,
    ph: 712, phr: 9200, phmv: 1857,
    tc: 2538, tv: 1,
    fix: 1, sat: 9, lat: Math.round(lat * 1e7), lon: Math.round(lon * 1e7),
    iv: 1, ir: 0, ip: 0, iy: Math.round(bearing * 100), ib: 2048, ia: 128,
    gb: 70000, gl: 1200,
    ns: navState,
    nd: Math.round(distanceM * 100),
    nt: Math.round(err * 100),
    bs: 1, bd: 350, rs: 0, rd: 0,
    xt: 0, ch: Math.round(bearing * 100),
    to: turn, lw: 60 + turn, rw: 60 - turn,
    hk: 2000, hi: 350, hd: 250, xk: 2300, xi: 300, xd: 120,
    aiph: 92, aiphn: 1, ait: 88, aitn: 1,
    mls: 100, mrs: 85, mlo: 0, mro: 10, mlz: 0, mrz: 0
  };
}

const dist = (a, b) => Math.hypot((b.latitude - a.latitude) * metersPerDegLat,
  (b.longitude - a.longitude) * mLonOf(a.latitude));

async function main() {
  const zoneId = process.argv[2] || 'zone_A';
  const timeoutMs = Number(process.argv[3]) || 240000;

  console.log('目标区域: ' + zoneId);

  /* 自愈：上次被掐断可能留下未结束的任务和占用的串口，
   * 不先清掉的话这次会直接失败。测试脚本必须可以反复跑。 */
  const pre = await req('GET', '/api/status');
  if (pre.sampling && pre.sampling.task) {
    console.log('清理上次残留的任务…');
    try { await req('POST', '/api/sampling/cancel'); } catch (e) { console.warn('  取消失败: ' + e.message); }
  }
  if (pre.status && pre.status.connected) {
    console.log('释放上次占用的串口…');
    try { await req('POST', '/api/serial/close'); } catch (e) { console.warn('  关闭失败: ' + e.message); }
  }
  if (pre.samples && pre.samples.length) {
    console.log('删除上次遗留的样本 ' + pre.samples.length + ' 条（保证本次计数干净）');
    try {
      await req('POST', '/api/samples/delete', { ids: pre.samples.map((s) => s.id) });
    } catch (e) { console.warn('  清理样本失败: ' + e.message); }
  }

  const status0 = await req('GET', '/api/status');
  const zone = (status0.zones || []).find((z) => z.id === zoneId && !z.deletedAt);
  if (!zone) { console.error('找不到区域 ' + zoneId); process.exit(2); }
  console.log('区域: ' + zone.name + '  中心 ' + zone.geometry.center.latitude + ', ' + zone.geometry.center.longitude);

  await req('PUT', '/api/sampling/config', FAST_CONFIG);
  console.log('采样参数已临时调快（验证结束后恢复）');

  // 哑串口：写出去没人收，只是让 writeSerialMessage 不报错
  try {
    await req('POST', '/api/serial/open', { path: 'COM5', baudRate: 115200 });
    console.log('已打开哑串口 COM5');
  } catch (e) {
    console.warn('打开 COM5 失败（' + e.message + '），尝试继续');
  }

  boat = { latitude: zone.geometry.center.latitude - 0.0003, longitude: zone.geometry.center.longitude - 0.0003 };
  console.log('虚拟船起点: ' + boat.latitude.toFixed(6) + ', ' + boat.longitude.toFixed(6));

  await req('POST', '/api/targets/zone', { zoneId });
  console.log('已下发巡检目标\n');

  const started = Date.now();
  let lastPhase = null;
  let lastPoint = -1;
  let injected = 0;
  let completed = false;

  while (Date.now() - started < timeoutMs) {
    const st = await req('GET', '/api/status');
    const task = st.sampling && st.sampling.task;
    const phase = task ? task.phase : 'idle';
    const pointIdx = task ? Number(task.currentPointIndex || 0) : -1;

    if (phase !== lastPhase || pointIdx !== lastPoint) {
      const ptxt = task && task.samplePoints ? ` 点 ${pointIdx + 1}/${task.samplePoints.length}` : '';
      const w = st.sampling.warning ? `   warning=${JSON.stringify(st.sampling.warning)}` : '';
      console.log(`  [${((Date.now() - started) / 1000).toFixed(1)}s] ${phase}${ptxt}${w}`);
      lastPhase = phase;
      lastPoint = pointIdx;
    }

    if (!task && st.sampling.status === 'idle' && Date.now() - started > 3000) {
      completed = true;
      break;
    }

    if (task && Array.isArray(task.samplePoints) && task.samplePoints.length) {
      const target = task.samplePoints[Math.min(pointIdx, task.samplePoints.length - 1)];
      const d = dist(boat, target);
      if (phase === 'navigating' && d > 0.6) {
        const step = 0.6 * 0.4; // 0.4s 走 0.6m/s
        const k = step / d;
        boat.latitude += (target.latitude - boat.latitude) * k;
        boat.longitude += (target.longitude - boat.longitude) * k;
      }
      const d2 = dist(boat, target);
      await req('POST', '/api/_bench/inject', {
        payload: makePayload(boat.latitude, boat.longitude, d2, d2 <= 2 ? 2 : 1, target)
      });
      injected += 1;
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  const final = await req('GET', '/api/status');
  const samples = (final.samples || []).filter((s) => s.zoneId === zoneId && !s.deletedAt);

  console.log('\n================ 结果 ================');
  console.log('注入帧数      : ' + injected);
  console.log('任务是否完成  : ' + (completed ? '是' : '否（超时）'));
  console.log('最终采样状态  : ' + final.sampling.status);
  console.log('该区域样本数  : ' + samples.length);
  if (samples.length) {
    const s = samples[0];
    console.log('样本示例      : zone=' + s.zoneId + ' source=' + s.source
      + ' attribution=' + s.attributionMethod + ' ph=' + s.water.ph + ' temp=' + s.water.tempC);
    console.log('GPS 校验      : validated=' + (s.gpsValidation && s.gpsValidation.validated)
      + ' arrivalMode=' + (s.gpsValidation && s.gpsValidation.arrivalMode)
      + ' 距目标=' + (s.gpsValidation && s.gpsValidation.distanceToTargetM) + 'm');
  }

  // 恢复成确定的默认值，而不是"读到的值"
  await req('PUT', '/api/sampling/config', DEFAULT_CONFIG);
  try { await req('POST', '/api/serial/close'); } catch {}
  console.log('采样参数已恢复，哑串口已关闭');

  process.exit(completed ? 0 : 1);
}

main().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
