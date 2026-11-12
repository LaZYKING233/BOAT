#!/usr/bin/env node
/**
 * 串口 <-> TCP 桥。跑在"中继盒子"上。
 *
 *   ┌──────────┐   USB    ┌────────────────┐   TCP    ┌────────────────┐
 *   │ LoRa 接收 │ ───────▶ │ 中继盒子        │ ───────▶ │ 这台电脑        │
 *   │ (CH340)  │          │ serial-bridge  │          │ WebUI(全部计算) │
 *   └──────────┘          └────────────────┘          └────────────────┘
 *
 * 盒子上只需要装 Node 和 serialport，不跑网页、不存数据、不做任何计算，
 * 只把串口字节原样转发到 TCP。
 *
 * 用法：
 *   node serial-bridge.js --port COM6
 *   node serial-bridge.js --port COM6 --baud 115200 --listen 4001
 *   node serial-bridge.js --port COM6 --host 0.0.0.0     # 允许外部连（默认）
 *
 * 然后在这台电脑上，把 WebUI 的串口地址填成：
 *   tcp://<盒子IP>:4001
 */

'use strict';

const net = require('net');

/* serialport 可能装在 WebUI 的 node_modules 里，也可能单独装过 */
function loadSerialPort() {
  const candidates = [
    'serialport',
    '../../WebUI/node_modules/serialport',
    '../../WebUI/node_modules/@serialport/stream',
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* 试下一个 */ }
  }
  console.error('找不到 serialport 模块。请在 WebUI 目录下运行，或先在盒子上 npm i serialport');
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; } else { out[key] = next; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const portPath = String(args.port || 'COM6');
const baudRate = Number(args.baud || 115200);
const listenPort = Number(args.listen || 4001);
const listenHost = String(args.host || '0.0.0.0');

const { SerialPort } = loadSerialPort();

const clients = new Set();
let serial = null;
let reopenTimer = null;

const stamp = () => new Date().toTimeString().slice(0, 8);

function broadcast(chunk, from) {
  for (const socket of clients) {
    if (socket === from || socket.destroyed) continue;
    try { socket.write(chunk); } catch { /* 单个客户端出错不影响整体 */ }
  }
}

function openSerial() {
  if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }

  serial = new SerialPort({ path: portPath, baudRate, autoOpen: false });

  serial.open((error) => {
    if (error) {
      console.error(`[${stamp()}] 打开 ${portPath} 失败: ${error.message}，3 秒后重试`);
      reopenTimer = setTimeout(openSerial, 3000);
      return;
    }
    console.log(`[${stamp()}] 串口已打开: ${portPath} @ ${baudRate}`);
  });

  serial.on('data', (chunk) => broadcast(chunk, null));

  serial.on('error', (error) => {
    console.error(`[${stamp()}] 串口错误: ${error.message}`);
  });

  serial.on('close', () => {
    console.warn(`[${stamp()}] 串口断开，3 秒后重连`);
    serial = null;
    if (!reopenTimer) reopenTimer = setTimeout(openSerial, 3000);
  });
}

openSerial();

const server = net.createServer((socket) => {
  clients.add(socket);
  socket.setNoDelay(true);
  console.log(`[${stamp()}] 客户端接入 ${socket.remoteAddress}（当前 ${clients.size} 个）`);

  /* 新客户端连上时，把最近的字节流不需要补发——遥测是周期性的，
   * 等下一帧即可，补发反而会让解析器收到半截 JSON。 */

  socket.on('data', (chunk) => {
    if (!serial || !serial.isOpen) return;
    serial.write(chunk, (error) => {
      if (error) console.error(`[${stamp()}] 写串口失败: ${error.message}`);
    });
  });

  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[${stamp()}] 客户端断开（剩 ${clients.size} 个）`);
  });

  socket.on('error', () => {
    clients.delete(socket);
  });
});

server.listen(listenPort, listenHost, () => {
  console.log('');
  console.log('  串口桥已启动');
  console.log(`  串口      ${portPath} @ ${baudRate}`);
  console.log(`  监听      ${listenHost}:${listenPort}`);
  console.log('');
  console.log('  在这台电脑上把 WebUI 的串口地址填成：');
  for (const addr of localAddresses()) {
    console.log(`    tcp://${addr}:${listenPort}`);
  }
  console.log('');
});

function localAddresses() {
  const os = require('os');
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out.length ? out : ['127.0.0.1'];
}

process.on('SIGINT', () => {
  console.log('\n退出中…');
  for (const socket of clients) { try { socket.destroy(); } catch { /* ignore */ } }
  if (serial && serial.isOpen) serial.close(() => process.exit(0));
  else process.exit(0);
});
