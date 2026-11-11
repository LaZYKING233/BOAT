#!/usr/bin/env node
'use strict';

const path = require('path');

/** 复用 WebUI 已安装的 serialport */
function loadSerialPort() {
  try { return require('serialport'); } catch { /* fallthrough */ }
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'WebUI', 'node_modules', 'serialport'),
    path.join(__dirname, '..', '..', '..', '..', 'WebUI', 'node_modules', 'serialport')
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error('找不到 serialport 模块：请先在 WebUI/ 下执行 npm install');
}

const { SerialPort } = loadSerialPort();

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400];

async function probe(portPath, baudRate, holdMs) {
  return new Promise((resolve) => {
    let bytes = 0;
    let sample = '';
    let opened = false;

    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });

    const finish = (err) => {
      try { if (port.isOpen) port.close(() => {}); } catch { /* ignore */ }
      setTimeout(() => resolve({ baudRate, bytes, sample, error: err ? String(err.message || err) : null }), 60);
    };

    port.open((err) => {
      if (err) { finish(err); return; }
      opened = true;
      port.on('data', (chunk) => {
        bytes += chunk.length;
        if (sample.length < 160) {
          sample += chunk.toString('latin1').replace(/[^\x20-\x7e\r\n]/g, '.');
        }
      });
      setTimeout(() => { if (opened) finish(null); }, holdMs);
    });

    port.on('error', (e) => finish(e));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const portPath = args[0];
  const holdMs = Number(args[1]) || 2500;
  if (!portPath) {
    console.error('用法: node baudscan.js <COMx> [每档监听毫秒数]');
    process.exit(2);
  }

  console.log('扫描 ' + portPath + '，每档监听 ' + holdMs + 'ms\n');
  const results = [];
  for (const baud of BAUDS) {
    const r = await probe(portPath, baud, holdMs);
    results.push(r);
    const verdict = r.error ? ('打开失败: ' + r.error) : (r.bytes > 0 ? (r.bytes + ' 字节') : '无数据');
    console.log('  ' + String(baud).padStart(6) + '  ->  ' + verdict);
    if (r.sample) console.log('          样本: ' + JSON.stringify(r.sample.slice(0, 100)));
  }

  const hits = results.filter((r) => r.bytes > 0);
  console.log('');
  if (!hits.length) {
    console.log('结论: 所有波特率都没有收到任何字节。');
    console.log('  -> 问题不在 PC 侧波特率，继续查：');
    console.log('     1) 船是否上电、固件是否在跑（板载 LED / 复位）');
    console.log('     2) LoRa 模块的 M0/M1 是否处于"透传模式"');
    console.log('     3) 接收端 LoRa 与船端 LoRa 的地址/信道是否一致');
    console.log('     4) TX/RX 是否接反、是否共地');
    process.exit(1);
  }
  const best = hits.sort((a, b) => b.bytes - a.bytes)[0];
  console.log('结论: ' + portPath + ' 在 ' + best.baudRate + ' 收到数据（' + best.bytes + ' 字节）');
  process.exit(0);
}

main();
