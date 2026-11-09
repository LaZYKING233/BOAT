#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { BoatClient } = require('../src/client');
const { analyze, renderReport } = require('../src/analyzer');
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
    seqStuck: Boolean(flags['stuck-seq'])
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
    sim [--port 3311] [--loop-ms 1000] [--gps] [--no-temp] [--no-imu] [--no-ph]
                                  启动模拟桥（无硬件时自测用）

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
