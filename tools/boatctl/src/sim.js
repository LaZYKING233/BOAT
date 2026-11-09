'use strict';

const http = require('http');
const path = require('path');

/**
 * 模拟上位机桥：用假的固件数据复刻 WebUI 的 HTTP + WebSocket 契约。
 *
 * 目的：在没有任何硬件（甚至没有 WebUI 进程）的情况下，
 * 验证 boatctl 的客户端、分析器、判定逻辑是否工作。
 *
 * 它故意实现了和真固件一样的 data 报文结构（定点整数），
 * 这样 decode.js 走的是完全相同的代码路径。
 */

function loadWebSocketServer() {
  try {
    return require('ws').WebSocketServer;
  } catch {
    // 复用 WebUI 已安装的 ws，避免额外 npm install
    const candidates = [
      path.join(__dirname, '..', '..', '..', 'WebUI', 'node_modules', 'ws'),
      path.join(__dirname, '..', '..', '..', '..', 'WebUI', 'node_modules', 'ws')
    ];
    for (const c of candidates) {
      try { return require(c).WebSocketServer; } catch { /* try next */ }
    }
    throw new Error('找不到 ws 模块：请先在 WebUI/ 下执行 npm install');
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function createSimulator(options = {}) {
  const opt = {
    port: 3311,
    loopMs: 1000,
    gpsFixed: false,
    tempOk: true,
    imuOk: true,
    phOk: true,
    aiOk: true,
    seqStuck: false,
    startSeq: 1,
    startUptimeMs: 5000,
    baseLat: 34.5001,
    baseLon: 104.0001,
    ...options
  };

  const state = {
    seq: opt.startSeq,
    uptimeMs: opt.startUptimeMs,
    connected: false,
    boat: { lat: opt.baseLat, lon: opt.baseLon },
    yaw: 0,
    target: null,
    navState: 0,
    motor: { l: 0, r: 0 },
    cal: { ls: 100, rs: 100, lo: 0, ro: 0 },
    aiPhSimilarity: 92,
    aiTempSimilarity: 88
  };

  let wss = null;
  let timer = null;
  const logs = [];

  const broadcast = (payload) => {
    const text = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(text);
    }
  };

  const serialStatus = () => ({
    connected: state.connected,
    portPath: state.connected ? 'SIM' : null,
    baudRate: state.connected ? 115200 : null,
    partialBytes: 0,
    lastMessageAt: new Date().toISOString()
  });

  const metersPerDegLat = 111320;
  const metersPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

  function bearingTo(lat1, lon1, lat2, lon2) {
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
    const x = Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180)
      - Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  function distanceTo(lat1, lon1, lat2, lon2) {
    const dy = (lat2 - lat1) * metersPerDegLat;
    const dx = (lon2 - lon1) * metersPerDegLon(lat1);
    return Math.sqrt(dx * dx + dy * dy);
  }

  const norm180 = (a) => { while (a > 180) a -= 360; while (a < -180) a += 360; return a; };

  function step(dtMs) {
    state.uptimeMs += opt.loopMs;
    if (!opt.seqStuck) state.seq += 1;

    // ---- 简单运动模型：有目标就朝目标走，走不到就保持 ----
    let headingError = 0;
    let distance = 0;
    if (state.target) {
      distance = distanceTo(state.boat.lat, state.boat.lon, state.target.lat, state.target.lon);
      const bearing = bearingTo(state.boat.lat, state.boat.lon, state.target.lat, state.target.lon);
      headingError = norm180(bearing - state.yaw);
      state.yaw = norm180(state.yaw + clamp(headingError, -30, 30) * 0.35);

      if (distance <= 1) {
        state.navState = 2;
      } else {
        state.navState = 1;
        const speed = 0.6 * (dtMs / 1000);
        const rad = (bearing * Math.PI) / 180;
        state.boat.lat += (Math.cos(rad) * speed) / metersPerDegLat;
        state.boat.lon += (Math.sin(rad) * speed) / metersPerDegLon(state.boat.lat);
      }
    } else {
      state.navState = 0;
    }

    const jitter = (n, amp) => Math.round(n + (Math.random() - 0.5) * 2 * amp);

    const fix = opt.gpsFixed || Boolean(state.target) ? 1 : 0;
    const lat = fix ? state.boat.lat : 0;
    const lon = fix ? state.boat.lon : 0;

    const payload = {
      t: 'data',
      v: 1,
      seq: state.seq,
      ms: state.uptimeMs,
      ph: opt.phOk ? jitter(717, 6) : 0,
      phr: opt.phOk ? jitter(9220, 40) : 0,
      phmv: opt.phOk ? jitter(1857, 8) : 0,
      tc: opt.tempOk ? jitter(2538, 4) : 0,
      tv: opt.tempOk ? 1 : 0,
      fix,
      sat: fix ? 9 : 0,
      lat: Math.round(lat * 1e7),
      lon: Math.round(lon * 1e7),
      iv: opt.imuOk ? 1 : 0,
      ir: opt.imuOk ? jitter(120, 20) : 0,
      ip: opt.imuOk ? jitter(-340, 20) : 0,
      iy: opt.imuOk ? Math.round(state.yaw * 100) : 0,
      ib: opt.imuOk ? 1024 + state.seq * 37 : 0,
      ia: opt.imuOk ? 128 + state.seq * 2 : 0,
      gb: opt.gpsFixed || state.target ? 70000 + state.seq * 210 : 0,
      gl: opt.gpsFixed || state.target ? 1200 + state.seq * 4 : 0,
      ns: state.navState,
      nd: state.navState !== 0 ? Math.round(distance * 100) : 0,
      nt: Math.round(headingError * 100),
      bs: state.target ? 1 : 0,
      bd: state.target ? jitter(350, 5) : 0,
      rs: 0,
      rd: 0,
      xt: state.target ? jitter(-20, 4) : 0,
      ch: Math.round(norm180(state.yaw + headingError) * 100),
      aiph: opt.aiOk ? state.aiPhSimilarity : 0,
      aiphn: opt.aiOk ? 1 : 0,
      ait: opt.aiOk ? state.aiTempSimilarity : 0,
      aitn: opt.aiOk ? 1 : 0,
      mls: state.cal.ls,
      mrs: state.cal.rs,
      mlo: state.cal.lo,
      mro: state.cal.ro
    };

    state.lastData = payload;

    if (state.connected) {
      const receivedAt = new Date().toISOString();
      broadcast({
        kind: 'serial-message',
        status: serialStatus(),
        latestData: payload,
        latestDataReceivedAt: receivedAt,
        entry: { id: state.seq, type: 'data', summary: 'sim', raw: JSON.stringify(payload) },
        log: { id: state.seq, direction: 'RX', text: JSON.stringify(payload), timestamp: receivedAt }
      });
    }
  }

  function statusPayload() {
    return {
      status: serialStatus(),
      latestBoot: { t: 'boot', v: 1, ms: 123, msg: 'boat telemetry start (SIM)', phdiv: 100, tbdiv: 150 },
      latestData: state.lastData || null,
      latestDataReceivedAt: new Date().toISOString(),
      history: [],
      logs,
      zones: [],
      samples: [],
      latestSampleByZone: {},
      sampling: { status: 'idle', task: null, warning: null, config: {} },
      builtinSpecies: {},
      llmConfig: { provider: 'disabled', enabled: false },
      gpsTest: {}
    };
  }

  function handleSend(message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return { ok: false }; }
    logs.push({ id: logs.length + 1, direction: 'TX', text: message, timestamp: new Date().toISOString() });
    if (msg.t === 'cmd' && msg.cmd === 'stop') {
      state.target = null; state.navState = 0; state.motor = { l: 0, r: 0 };
    }
    if (msg.t === 'motor') state.motor = { l: msg.l, r: msg.r };
    if (msg.t === 'mcal') state.cal = { ls: Math.round(msg.ls * 100), rs: Math.round(msg.rs * 100), lo: msg.lo, ro: msg.ro };
    if (msg.t === 'target') {
      state.target = { lat: msg.lat / 1e7, lon: msg.lon / 1e7 };
      state.navState = 1;
    }
    if (state.connected) {
      broadcast({
        kind: 'serial-message',
        status: serialStatus(),
        latestData: state.lastData,
        latestDataReceivedAt: new Date().toISOString(),
        entry: { id: Date.now(), type: 'ack', summary: 'ack', raw: message },
        log: { id: Date.now(), direction: 'TX', text: message, timestamp: new Date().toISOString() }
      });
    }
    return { ok: true };
  }

  function start() {
    const WebSocketServer = loadWebSocketServer();

    const server = http.createServer((req, res) => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const url = req.url.split('?')[0];
        if (url === '/api/health') return send(200, { ok: true, status: serialStatus() });
        if (url === '/api/status') return send(200, statusPayload());
        if (url === '/api/ports') return send(200, { ports: [{ path: 'SIM', manufacturer: 'boatctl', friendlyName: '模拟器' }] });
        if (url === '/api/serial/open') {
          state.connected = true;
          broadcast({ kind: 'serial-status', status: serialStatus() });
          return send(200, { ok: true, message: '已连接 SIM', status: serialStatus() });
        }
        if (url === '/api/serial/close') {
          state.connected = false;
          return send(200, { ok: true, message: '已断开', status: serialStatus() });
        }
        if (url === '/api/serial/send') {
          const parsed = body ? JSON.parse(body) : {};
          return send(200, handleSend(parsed.message || '{}'));
        }
        if (url === '/api/targets/zone') {
          return send(200, { ok: true, sampling: { status: 'navigating', task: { zoneId: 'SIM' } } });
        }
        if (url === '/api/sampling/cancel') {
          state.target = null; state.navState = 0;
          return send(200, { ok: true, sampling: { status: 'idle', task: null } });
        }
        return send(404, { message: 'not found' });
      });
    });

    wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({ kind: 'snapshot', ...statusPayload() }));
    });

    return new Promise((resolve) => {
      server.listen(opt.port, '127.0.0.1', () => {
        timer = setInterval(() => step(opt.loopMs), opt.loopMs);
        resolve({
          url: `http://127.0.0.1:${opt.port}`,
          stop: () => {
            clearInterval(timer);
            for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } }
            wss.close();
            server.close();
          }
        });
      });
    });
  }

  return { start, state, options: opt };
}

module.exports = { createSimulator };
