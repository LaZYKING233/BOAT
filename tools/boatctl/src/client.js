'use strict';

const http = require('http');
const { EventEmitter } = require('events');
const { decodeTelemetry } = require('./decode');

/**
 * BoatClient —— 上位机与船之间的唯一通道。
 *
 * 设计取舍：不直接抢串口，而是走 WebUI 的 HTTP + WebSocket 桥。
 * 好处是串口只有一个 owner（WebUI），两边不会互相踢掉；
 * 代价是必须先启动 WebUI。零依赖：Node 22+ 自带全局 WebSocket。
 *
 * 典型用法：
 *   const c = new BoatClient();
 *   await c.connect();
 *   await c.cmd('stop');
 *   await c.waitFor(t => t.tempValid === true, 5000);
 *   const samples = await c.collect(3000);
 *   c.close();
 */
class BoatClient extends EventEmitter {
  constructor({ url = 'http://127.0.0.1:3000', timeoutMs = 8000, historyLimit = 20000 } = {}) {
    super();
    this.url = String(url).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.historyLimit = historyLimit;

    this.status = null;
    this.latest = null;
    this.history = [];
    this.logs = [];

    this._ws = null;
    this._wsOpen = false;
    this._lastSeq = null;
    this._lastAck = null;
    this._connectedAt = null;
    this._waiters = new Set();
  }

  // ---------------------------------------------------------------- HTTP

  request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const target = new URL(path, this.url);

      const req = http.request(
        {
          method,
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': payload.length } : {})
          },
          timeout: this.timeoutMs
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 原样返回 */ }
            if (res.statusCode >= 400) {
              const message = (json && json.message) || text.slice(0, 200) || ('HTTP ' + res.statusCode);
              const error = new Error(message);
              error.statusCode = res.statusCode;
              reject(error);
              return;
            }
            resolve(json);
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error('请求超时: ' + path)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ------------------------------------------------------------ 连接管理

  /** 只探活，不建立 WebSocket */
  async ping() {
    return this.request('GET', '/api/health');
  }

  async getStatus() {
    return this.request('GET', '/api/status');
  }

  async listPorts() {
    const res = await this.request('GET', '/api/ports');
    return res.ports || [];
  }

  /** 建立 WebSocket 并等待首帧 snapshot */
  async connect({ timeoutMs = 8000 } = {}) {
    if (this._wsOpen) return this;

    const snapshotPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 握手超时：WebUI 是否在运行？')), timeoutMs);
      this.once('_snapshot', () => { clearTimeout(timer); resolve(); });
      this.once('_ws_error', (e) => { clearTimeout(timer); reject(e); });
    });

    const wsUrl = this.url.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._wsOpen = true;
      this._connectedAt = Date.now();
      this.emit('open');
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this._handleMessage(msg);
    });

    ws.addEventListener('error', () => {
      const err = new Error('WebSocket 错误：WebUI 是否在运行？');
      this.emit('_ws_error', err);
    });

    ws.addEventListener('close', () => {
      this._wsOpen = false;
      this.emit('close');
    });

    await snapshotPromise;
    return this;
  }

  close() {
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
    }
    this._ws = null;
    this._wsOpen = false;
    for (const w of this._waiters) w.resolve(false);
    this._waiters.clear();
  }

  // -------------------------------------------------------- 消息分发

  _handleMessage(msg) {
    switch (msg.kind) {
      case 'snapshot':
        this._applyStatus(msg);
        this.emit('_snapshot');
        break;

      case 'serial-message': {
        if (msg.status) this.status = { ...(this.status || {}), ...msg.status };
        if (msg.log) this._pushLog(msg.log);

        /* MCU 收到下行命令会回一条 {"t":"ack","kind":...}。
         * 可靠下发靠它判断是否真的生效——LoRa 下行有字节丢失，
         * 没收到 ack 就意味着这条命令大概率被截断了。 */
        if (msg.entry && msg.entry.type === 'ack') {
          try {
            const ack = JSON.parse(msg.entry.raw);
            this._lastAck = { ...ack, rxAt: Date.now() };
            this.emit('ack', this._lastAck);
          } catch { /* 半截的 ack，忽略 */ }
        }
        const raw = msg.latestData;
        if (raw && raw.t === 'data' && raw.seq !== this._lastSeq) {
          this._lastSeq = raw.seq;
          const t = decodeTelemetry(raw, Date.now());
          if (t) this._pushTelemetry(t);
        }
        break;
      }

      case 'serial-status':
        if (msg.status) this.status = { ...(this.status || {}), ...msg.status };
        this.emit('status', this.status);
        break;

      case 'serial-log':
        if (msg.log) this._pushLog(msg.log);
        break;

      case 'sampling-update':
        if (msg.sampling) this.emit('sampling', msg.sampling);
        break;

      case 'sample-created':
        this.emit('sample', msg.sample);
        break;

      default:
        break;
    }
  }

  _applyStatus(payload) {
    if (payload.status) this.status = payload.status;
    this.emit('status', this.status);
    const raw = payload.latestData;
    if (raw && raw.t === 'data') {
      this._lastSeq = raw.seq;
      const t = decodeTelemetry(raw, Date.now());
      if (t) this._pushTelemetry(t);
    }
  }

  _pushTelemetry(t) {
    this.latest = t;
    this.history.push(t);
    if (this.history.length > this.historyLimit) this.history.shift();
    this.emit('telemetry', t);
    for (const w of [...this._waiters]) {
      if (w.predicate(t)) {
        w.resolve(t);
        this._waiters.delete(w);
      }
    }
  }

  _pushLog(log) {
    this.logs.push(log);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', log);
  }

  // ------------------------------------------------------------ 下行控制

  async openSerial(port, baudRate = 115200) {
    return this.request('POST', '/api/serial/open', { path: port, baudRate });
  }

  async closeSerial() {
    return this.request('POST', '/api/serial/close');
  }

  /** 发送任意 JavaScript 对象（自动 JSON 化 + CRLF） */
  async send(obj) {
    return this.request('POST', '/api/serial/send', {
      message: typeof obj === 'string' ? obj : JSON.stringify(obj),
      appendNewline: true,
      broadcast: false
    });
  }

  async cmd(name) { return this.send({ t: 'cmd', cmd: name }); }

  async motor(left, right) {
    return this.send({ t: 'motor', l: Math.round(left), r: Math.round(right) });
  }

  async mcal(ls, rs, lo = 0, ro = 0) {
    return this.send({ t: 'mcal', ls, rs, lo, ro });
  }

  /**
   * 运行时下发 PID 增益（免重新编译烧录）。
   * 只传想改的项，其余保持固件当前值。
   * @param {object} g { hkp,hki,hkd, xkp,xki,xkd }
   */
  async setPid(g = {}) {
    const msg = { t: 'pid' };
    for (const k of ['hkp', 'hki', 'hkd', 'xkp', 'xki', 'xkd']) {
      if (g[k] !== undefined && Number.isFinite(Number(g[k]))) msg[k] = Number(g[k]);
    }
    if (Object.keys(msg).length === 1) throw new Error('setPid 没有提供任何增益');
    return this.send(msg);
  }

  async stop() { return this.cmd('stop'); }

  async targetZone(zoneId) {
    return this.request('POST', '/api/targets/zone', { zoneId });
  }

  /**
   * 纯导航：直接下发一个 target，不启动 WebUI 的 8 点巡检任务。
   * 整定 PID 时用这个——采样状态机会在附近做稳定/采样，干扰航向数据。
   */
  async goto(lat, lon, { arrive = 2, hold = 6, drift = 8 } = {}) {
    return this.send({
      t: 'target',
      lat: Math.round(lat * 1e7),
      lon: Math.round(lon * 1e7),
      r: hold,
      ar: arrive,
      rr: drift
    });
  }

  async cancelTask() {
    return this.request('POST', '/api/sampling/cancel');
  }

  // ------------------------------------------------------------ 采集原语

  isConnected() {
    return Boolean(this._wsOpen && this.status && this.status.connected);
  }

  /**
   * 等待满足条件的遥测帧。
   * @param {(t:object)=>boolean} predicate
   * @param {number} timeoutMs 超时返回 null
   */
  waitFor(predicate, timeoutMs = 10000) {
    if (this.latest && predicate(this.latest)) return Promise.resolve(this.latest);
    return new Promise((resolve) => {
      const waiter = { predicate, resolve: null };
      const timer = setTimeout(() => {
        this._waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      waiter.resolve = (t) => { clearTimeout(timer); resolve(t); };
      this._waiters.add(waiter);
    });
  }

  /**
   * 等待"某个时刻之后新收到"的帧。
   * 用于验证下行命令是否生效——直接用 waitFor 会命中缓存的旧帧。
   */
  waitFresh(timeoutMs = 5000) {
    const since = Date.now();
    return this.waitFor((t) => t.rxAt > since, timeoutMs);
  }

  /**
   * 可靠下行：发出去，等 MCU 的 ack，没等到就重发。
   *
   * LoRa 下行存在字节丢失（实测报文越长越容易截断，150 字节的 target 几乎必然失败），
   * 逐字节的重传不现实，只能整包重发。短命令通常一次就成，
   * 长命令靠重试也能在几次内通过。
   *
   * @param {object} obj        要发送的 JSON
   * @param {object} opts
   * @param {string} opts.expectAck  ack 里的 kind（如 'pid' / 'mcal' / 'target'）
   * @param {number} opts.retries    最多尝试次数，默认 6
   * @param {number} opts.perTryMs   每次等待 ack 的时间，默认 2500
   * @returns {Promise<{ok:boolean, attempts:number, ack:object|null}>}
   */
  async sendReliable(obj, { expectAck = null, retries = 6, perTryMs = 2500 } = {}) {
    const kind = expectAck || obj.t;
    let lastAck = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const sentAt = Date.now();
      await this.send(obj);

      const deadline = Date.now() + perTryMs;
      while (Date.now() < deadline) {
        const ack = this._lastAck;
        if (ack && ack.rxAt >= sentAt && ack.kind === kind) {
          return { ok: true, attempts: attempt, ack };
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      lastAck = this._lastAck;
    }

    return { ok: false, attempts: retries, ack: lastAck };
  }

  /** 这段时间内收到的新帧（不含已有的） */
  collect(durationMs = 5000) {
    return new Promise((resolve) => {
      const bucket = [];
      const onData = (t) => bucket.push(t);
      this.on('telemetry', onData);
      setTimeout(() => {
        this.removeListener('telemetry', onData);
        resolve(bucket);
      }, durationMs);
    });
  }

  /** 相对本次连接开始的 elapsed，用于对齐固件 uptime */
  elapsedMs() {
    return this._connectedAt ? Date.now() - this._connectedAt : 0;
  }
}

module.exports = { BoatClient };
