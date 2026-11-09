#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { BoatClient } = require('../src/client');
const { analyze, renderReport } = require('../src/analyzer');
const { analyzeRun, renderReport: renderPidReport } = require('../src/pid');
const { createSimulator } = require('../src/sim');

// ------------------------------------------------------------------ 工具

function parseDuration(text, fallbackMs) {
  if (text === undefined || text === null || text === '') return fallbackMs;
  const m = String(text).trim().match(/^([0-9.]+)\s*(ms|s|m|h)?$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit] || 1000;
  return Math.round(n * mult);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; }
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const fmt = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

// 中文字符占两列，padEnd 会算错，这里按显示宽度补齐
const strWidth = (s) => [...String(s)].reduce(
  (w, c) => w + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1),
  0
);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - strWidth(s)));

// 从 stdin 读全部内容（用于 send - ）
function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    setTimeout(() => resolve(buf), 300);
  });
}

function printStatus(s, t) {
  const line = (k, v) => console.log(`  ${pad(k, 16)} ${v}`);
  console.log('');
  console.log('  === 链路 ===');
  line('串口', s && s.connected ? `${s.portPath} @ ${s.baudRate}` : '未连接');
  line('最后消息', s && s.lastMessageAt ? s.lastMessageAt : '—');
  if (!t) { console.log('\n  （还没有遥测帧）\n'); return; }
  console.log('  === 遥测 ===');
  line('seq / uptime', `${t.seq} / ${(t.uptimeMs / 1000).toFixed(1)}s`);
  line('pH', `${fmt(t.ph)}  (raw ${t.phRaw}, ${t.phMv}mV)`);
  line('水温', t.tempValid ? `${fmt(t.tempC)}℃` : '无效');
  line('GPS', t.fix > 0 ? `fix=${t.fix} sat=${t.satellites} ${fmt(t.lat, 7)}, ${fmt(t.lon, 7)}` : `未定位（已收 ${t.gpsRxBytes} 字节）`);
  line('IMU', t.imuValid ? `yaw=${fmt(t.yaw, 1)}° roll=${fmt(t.roll, 1)}° pitch=${fmt(t.pitch, 1)}° 帧=${t.imuFrames}` : '无效');
  line('导航', `${t.navStateName}${t.distanceM !== null ? ` ${fmt(t.distanceM, 1)}m` : ''} 误差=${fmt(t.headingErrorDeg, 1)}°`);
  line('边缘 AI', `pH 相似度 ${t.aiPhSimilarity ?? '—'} (${t.aiPhNormal ? '正常' : '异常'}) | 温度 ${t.aiTempSimilarity ?? '—'}`);
  line('电机校准', `L×${fmt(t.motorLeftScale)} R×${fmt(t.motorRightScale)} off=${t.motorLeftOffset}/${t.motorRightOffset}`);
  console.log('');
}

// ------------------------------------------------------------------ 命令

async function cmdPorts(client, flags) {
  const ports = await client.listPorts();
  if (flags.json) { console.log(JSON.stringify(ports, null, 2)); return 0; }
  if (!ports.length) { console.log('没有发现串口'); return 0; }
  console.log('');
  for (const p of ports) {
    console.log(`  ${pad(p.path, 10)} ${p.friendlyName || ''} ${p.manufacturer ? '· ' + p.manufacturer : ''}`);
  }
  console.log('');
  return 0;
}

async function cmdStatus(client, flags) {
  await client.connect();
  const t = client.latest;
  if (flags.json) {
    console.log(JSON.stringify({ status: client.status, telemetry: t }, null, 2));
  } else {
    printStatus(client.status, t);
  }
  return 0;
}

async function cmdWatch(client, flags) {
  const duration = parseDuration(flags.duration, 15000);
  await client.connect();
  console.log('');
  console.log(`  ${pad('时间', 10)} ${pad('seq', 6)} ${pad('周期', 8)} ${pad('pH', 7)} ${pad('水温', 8)} ${pad('yaw', 8)} ${pad('导航', 13)} ${pad('距离', 8)}`);
  console.log('  ' + '-'.repeat(80));

  let prevUptime = null;
  const onData = (t) => {
    const loop = prevUptime === null ? null : t.uptimeMs - prevUptime;
    prevUptime = t.uptimeMs;
    const time = new Date(t.rxAt).toLocaleTimeString('zh-CN', { hour12: false });
    console.log(
      '  ' + pad(time, 10) + pad(t.seq, 6) + pad(loop === null ? '—' : loop + 'ms', 8)
      + pad(fmt(t.ph), 7) + pad(t.tempValid ? fmt(t.tempC) + '℃' : '无效', 8)
      + pad(fmt(t.yaw, 1) + '°', 8) + pad(t.navStateName, 13)
      + pad(t.distanceM === null ? '—' : fmt(t.distanceM, 1) + 'm', 8)
    );
  };
  client.on('telemetry', onData);
  await new Promise((r) => setTimeout(r, duration));
  console.log('');
  return 0;
}

/**
 * 发送下行 JSON。
 * PowerShell 会把参数里的双引号吃掉，所以支持三种入口：
 *   send '{"t":"cmd","cmd":"stop"}'
 *   send --file cmd.json
 *   echo '{"t":"cmd","cmd":"stop"}' | send -
 */
async function cmdSend(client, positional, flags) {
  let text = '';
  if (flags.file) {
    text = fs.readFileSync(path.resolve(flags.file), 'utf8');
  } else if (positional[0] === '-' || (!positional.length && !process.stdin.isTTY)) {
    text = await readStdin();
  } else {
    text = positional.join(' ');
  }

  text = String(text).trim();
  if (!text) { console.error('用法: send <json> | send --file x.json | ... | send -'); return 2; }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    console.error('不是合法 JSON: ' + e.message);
    console.error('提示: PowerShell 下建议用 --file 或管道，避免双引号被吞掉');
    return 2;
  }

  await client.send(obj);
  console.log('已发送: ' + JSON.stringify(obj));
  return 0;
}

async function cmdSelftest(client, flags) {
  const duration = parseDuration(flags.duration, 15000);
  const waitFirst = parseDuration(flags.wait, 15000);
  const result = { startedAt: new Date().toISOString(), steps: [], report: null };

  const step = (name, status, detail) => {
    result.steps.push({ name, status, detail });
    const icon = status === 'ok' ? '  OK  ' : status === 'warn' ? ' WARN ' : ' FAIL ';
    console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
  };

  // 1. WebUI 可达
  try {
    await client.ping();
    step('WebUI 可达', 'ok', client.url);
  } catch (e) {
    step('WebUI 可达', 'fail', e.message);
    return finish(result, flags, 1);
  }

  // 2. 串口
  try {
    await client.connect();
    if (flags.open) {
      await client.openSerial(flags.open, Number(flags.baud) || 115200);
      step('串口已连接', 'ok', `${flags.open} @ ${Number(flags.baud) || 115200}`);
      await new Promise((r) => setTimeout(r, 500));
      await client.connect().catch(() => {});
    }
    const connected = client.status && client.status.connected;
    step('串口状态', connected ? 'ok' : 'fail', connected ? client.status.portPath : `未连接（可用 --open COMx 自动连接）`);
    if (!connected) return finish(result, flags, 1);
  } catch (e) {
    step('串口状态', 'fail', e.message);
    return finish(result, flags, 1);
  }

  // 3. 首帧
  const first = await client.waitFor(() => true, waitFirst);
  if (!first) {
    step('收到首帧遥测', 'fail', `${waitFirst}ms 内没有数据：查 LoRa 接线/波特率，或固件是否在运行`);
    return finish(result, flags, 1);
  }
  step('收到首帧遥测', 'ok', 'seq=' + first.seq);
  await new Promise((r) => setTimeout(r, 1500));

  // 4. 采集窗口
  const samples = await client.collect(duration);
  if (!samples.length) {
    step('采集窗口', 'fail', '窗口内没有新帧');
    return finish(result, flags, 1);
  }
  step('采集窗口', 'ok', `${samples.length} 帧 / ${(duration / 1000).toFixed(0)} 秒`);

  // 5. 分析
  const report = analyze(samples);
  result.report = report;
  console.log(renderReport(report));

  const exitCode = report.summary.fail > 0 ? 1 : 0;
  return finish(result, flags, exitCode);
}

function finish(result, flags, exitCode) {
  result.exitCode = exitCode;
  result.finishedAt = new Date().toISOString();
  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(path.resolve(flags.out), JSON.stringify(result, null, 2), 'utf8');
    console.log('  报告已写入: ' + path.resolve(flags.out));
  }
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  console.log(exitCode === 0 ? '\n  === 自检通过 ===\n' : '\n  === 自检未通过 ===\n');
  return exitCode;
}

async function cmdRecord(client, flags) {
  const duration = parseDuration(flags.duration, 30000);
  await client.connect();
  const outPath = path.resolve(flags.out || `record-${Date.now()}.jsonl`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(outPath, 'w');
  let n = 0;
  const onData = (t) => { fs.writeSync(fd, JSON.stringify(t) + '\n'); n += 1; };
  client.on('telemetry', onData);
  await new Promise((r) => setTimeout(r, duration));
  fs.closeSync(fd);
  console.log(`已录制 ${n} 帧 -> ${outPath}`);
  return 0;
}

/** "2.0,0.35,0.25" -> { kp, ki, kd } */
function parseGains(text) {
  if (!text || text === true) return null;
  const parts = String(text).split(',').map((v) => Number(v.trim()));
  if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) return null;
  return { kp: parts[0], ki: parts[1], kd: parts[2] };
}

function parseLatLon(text) {
  if (!text || text === true) return null;
  const parts = String(text).split(',').map((v) => Number(v.trim()));
  if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v))) return null;
  return { lat: parts[0], lon: parts[1] };
}

/** 需要时自动连串口，让整条流程真正无人值守 */
async function ensureSerial(client, flags) {
  if (!flags.open) return;
  await client.openSerial(flags.open, Number(flags.baud) || 115200);
  await new Promise((r) => setTimeout(r, 600));
  await client.getStatus().then((s) => { if (s.status) client.status = s.status; }).catch(() => {});
}

async function cmdGoto(client, positional, flags) {
  let ll = parseLatLon(flags.to || positional.join(','));
  if (!ll) { console.error('用法: goto <lat> <lon>  或  goto --to 34.5005,104.0005'); return 2; }
  await client.connect();
  await ensureSerial(client, flags);
  if (!client.isConnected()) { console.error('串口未连接，请先在 WebUI 里连接 LoRa 接收端，或加 --open COMx'); return 1; }
  await client.goto(ll.lat, ll.lon, {
    arrive: Number(flags.arrive) || 2,
    hold: Number(flags.hold) || 6,
    drift: Number(flags.drift) || 8
  });
  console.log(`已下发目标: ${ll.lat}, ${ll.lon}  (到达 ${Number(flags.arrive) || 2}m / 保持 ${Number(flags.hold) || 6}m)`);
  return 0;
}

/**
 * 一次完整的"设定目标 -> 实跑到点 -> 落盘"。
 * 整定 PID 的标准动作：每改一次参数就跑一次，数据自动归档，事后可比。
 */
async function cmdNavrun(client, flags) {
  await client.connect();
  await ensureSerial(client, flags);
  if (!client.isConnected()) { console.error('串口未连接（可加 --open COMx 自动连接）'); return 1; }

  const outDir = path.resolve(flags.outdir || 'runs');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = (flags.label ? String(flags.label) + '-' : '') + stamp;

  const meta = {
    runId,
    startedAt: new Date().toISOString(),
    url: client.url,
    gains: parseGains(flags.gains),
    xgains: parseGains(flags.xgains),
    arriveRadiusM: Number(flags.arrive) || 2,
    holdRadiusM: Number(flags.hold) || 6,
    note: typeof flags.note === 'string' ? flags.note : ''
  };

  const ll = parseLatLon(flags.to);
  if (ll) {
    meta.target = ll;
    await client.goto(ll.lat, ll.lon, {
      arrive: meta.arriveRadiusM,
      hold: meta.holdRadiusM,
      drift: Number(flags.drift) || 8
    });
    console.log(`目标已下发: ${ll.lat}, ${ll.lon}`);
  } else {
    console.log('未指定 --to，假设船已经在导航中');
  }

  const samples = [];
  const onData = (t) => samples.push(t);
  client.on('telemetry', onData);

  const timeoutMs = parseDuration(flags.timeout, 180000);
  const startMs = Date.now();
  let holdingSince = null;
  let sawNavigating = false;
  let firstDataMs = null;
  let stopReason = null;

  process.stdout.write('  采集中');
  while (true) {
    await new Promise((r) => setTimeout(r, 250));
    const t = client.latest;
    if (t) {
      if (firstDataMs === null) firstDataMs = Date.now();
      if (t.navState === 1) sawNavigating = true;
      if (t.navState === 2) { if (holdingSince === null) holdingSince = Date.now(); }
      else holdingSince = null;
    }

    if (firstDataMs !== null && Date.now() - firstDataMs > 15000 && !sawNavigating) {
      stopReason = 'never_navigated';
      break;
    }
    if (holdingSince !== null && Date.now() - holdingSince > 3000) { stopReason = 'arrived'; break; }
    if (Date.now() - startMs > timeoutMs) { stopReason = 'timeout'; break; }
  }
  client.removeListener('telemetry', onData);
  console.log(` 完成（${stopReason}），${samples.length} 帧`);

  meta.endedAt = new Date().toISOString();
  meta.stopReason = stopReason;
  meta.frames = samples.length;

  if (!samples.length) {
    console.error('没有采到任何遥测帧，未写文件');
    return 1;
  }

  const jsonlPath = path.join(outDir, runId + '.jsonl');
  const metaPath = path.join(outDir, runId + '.meta.json');
  fs.writeFileSync(jsonlPath, samples.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  console.log('  数据: ' + jsonlPath);

  const report = analyzeRun(samples, {
    turnLimit: Number(flags['turn-limit']) || undefined,
    gains: meta.gains,
    xgains: meta.xgains
  });
  console.log(renderPidReport(report, { samples, plot: flags['no-plot'] ? false : true }));

  return report.summary.fail > 0 ? 1 : 0;
}

function cmdPidreport(positional, flags) {
  const file = positional[0];
  if (!file) { console.error('用法: pidreport <run.jsonl>'); return 2; }
  const resolved = path.resolve(file);
  const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/).filter(Boolean);
  const samples = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  let meta = {};
  const metaPath = resolved.replace(/\.jsonl$/, '.meta.json');
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* ignore */ }
  }

  const report = analyzeRun(samples, {
    turnLimit: Number(flags['turn-limit']) || undefined,
    gains: meta.gains || parseGains(flags.gains),
    xgains: meta.xgains || parseGains(flags.xgains)
  });

  if (flags.json) { console.log(JSON.stringify(report, null, 2)); return report.summary.fail > 0 ? 1 : 0; }
  console.log(renderPidReport(report, { samples, plot: flags['no-plot'] ? false : true }));
  return report.summary.fail > 0 ? 1 : 0;
}

function cmdAnalyze(positional, flags) {
  const file = positional[0];
  if (!file) { console.error('用法: analyze <record.jsonl>'); return 2; }
  const lines = fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/).filter(Boolean);
  const samples = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const report = analyze(samples);
  if (flags.json) { console.log(JSON.stringify(report, null, 2)); return report.summary.fail > 0 ? 1 : 0; }
  console.log(renderReport(report));
  return report.summary.fail > 0 ? 1 : 0;
}

async function cmdSim(positional, flags) {
  const sim = createSimulator({
    port: Number(flags.port) || 3311,
    loopMs: Number(flags['loop-ms']) || 1000,
    gpsFixed: Boolean(flags.gps),
    tempOk: !flags['no-temp'],
    imuOk: !flags['no-imu'],
    phOk: !flags['no-ph'],
    aiOk: !flags['no-ai'],
    seqStuck: Boolean(flags['stuck-seq']),
    kp: Number(flags.kp) || 1.5,
    driftMps: flags.drift === undefined ? 0.35 : Number(flags.drift)
  });
  const handle = await sim.start();
  console.log('模拟桥已启动: ' + handle.url + '   (Ctrl+C 退出)');
  console.log('试试: node bin/boatctl.js selftest --url ' + handle.url + ' --open SIM');
  await new Promise((resolve) => {
    process.on('SIGINT', () => { handle.stop(); resolve(); });
  });
  return 0;
}

function printHelp() {
  console.log(`
  boatctl —— 智航清泓上位机（自动化控制 / 遥测诊断）

  全局参数
    --url <url>       WebUI 地址，默认 http://127.0.0.1:3000
    --json            以 JSON 输出（便于脚本消费）

  命令
    ports                         列出串口
    status                        打印当前状态快照
    watch [--duration 15s]        实时滚屏
    send '<json>'                 发送任意下行 JSON
    cmd <stop|start|sensor>       发送快捷指令
    selftest [--open COMx]        全自动自检（推荐入口）
             --duration 15s         采集窗口
             --wait 15s             首帧超时
             --out report.json      写报告
    record --out x.jsonl [--duration 60s]
    analyze <x.jsonl>             离线分析录制文件

    goto <lat> <lon>              纯导航到点（不启动采样任务）
             [--arrive 2] [--hold 6] [--drift 8]
    navrun --to lat,lon           设定目标 -> 实跑到点 -> 自动落盘并分析
             [--open COMx]            自动连接串口，无需手动点
             [--gains 2.0,0.35,0.25]  记录本次使用的航向 PID 增益
             [--xgains 2.3,0.30,0.12] 记录横向修正增益
             [--timeout 180s] [--outdir runs] [--label 试验1] [--note "..."]
    pidreport <run.jsonl>         复盘一次实跑，给出参数调整方向
    sim [--port 3311] [--loop-ms 1000] [--gps] [--no-temp] [--no-imu] [--no-ph]
                                  启动模拟桥（无硬件时自测用）
        [--kp 1.5]                模拟的航向增益，调大即可复现振荡
        [--drift 0.35]            侧向水流漂移（m/s），PID 要对抗的就是它

  退出码
    0 通过    1 有失败项    2 参数错误
`);
  return 0;
}

// ------------------------------------------------------------------ 入口

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift() || 'help';
  const url = flags.url || 'http://127.0.0.1:3000';

  if (command === 'help' || command === '--help' || command === '-h') return printHelp();
  if (command === 'sim') return cmdSim(positional, flags);
  if (command === 'analyze') return cmdAnalyze(positional, flags);
  if (command === 'pidreport') return cmdPidreport(positional, flags);

  const client = new BoatClient({ url });
  try {
    switch (command) {
      case 'ports': return await cmdPorts(client, flags);
      case 'status': return await cmdStatus(client, flags);
      case 'watch': return await cmdWatch(client, flags);
      case 'send': return await cmdSend(client, positional, flags);
      case 'cmd': return await cmdSend(client, [JSON.stringify({ t: 'cmd', cmd: positional[0] })], {});
      case 'motor': return await cmdSend(client, [JSON.stringify({ t: 'motor', l: Number(positional[0] || 0), r: Number(positional[1] || 0) })], {});
      case 'selftest': return await cmdSelftest(client, flags);
      case 'record': return await cmdRecord(client, flags);
      case 'goto': return await cmdGoto(client, positional, flags);
      case 'navrun': return await cmdNavrun(client, flags);
      default:
        console.error('未知命令: ' + command);
        printHelp();
        return 2;
    }
  } catch (e) {
    console.error('错误: ' + e.message);
    return 1;
  } finally {
    client.close();
  }
}

main().then((code) => {
  // 给 WebSocket 一点时间收尾
  setTimeout(() => process.exit(code || 0), 120);
});
