const express = require('express');
const fs = require('fs');
const path = require('path');
const { SerialPort } = require('serialport');

const HTTP_PORT = process.env.COLLECTOR_PORT ? Number(process.env.COLLECTOR_PORT) : 3100;
const DEFAULT_BAUD_RATE = 115200;
const CONFIG_FILE = path.join(__dirname, 'collector-config.json');

const CSV_COLUMNS = [
  'session_id',
  'timestamp_iso',
  'timestamp_ms',
  'target_sensor',
  'manual_label',
  'fault_type',
  'scene_label',
  'note',
  'seq',
  'uptime_ms',
  'ph',
  'ph_raw',
  'ph_mv',
  'turbidity',
  'turbidity_raw',
  'turbidity_mv',
  'turbidity_dout',
  'turbidity_valid',
  'temperature',
  'temperature_valid',
  'gps_fix',
  'gps_sat',
  'gps_lat',
  'gps_lon',
  'imu_valid',
  'roll',
  'pitch',
  'yaw',
  'nav_state',
  'nav_distance_m',
  'nav_heading_error_deg',
  'ph_delta',
  'ph_mv_delta',
  'turbidity_delta',
  'turbidity_mv_delta',
  'temperature_delta',
  'yaw_delta',
  'sample_interval_ms',
  'raw_json',
];

const DEFAULT_CONFIG = {
  lastPort: '',
  lastBaudRate: DEFAULT_BAUD_RATE,
  lastSaveDir: path.resolve(__dirname, '..', '..', 'edge_ai_data', 'raw'),
  lastFileName: '',
  lastTargetSensor: 'temperature',
  lastManualLabel: 'normal',
  lastFaultType: 'none',
  lastSceneLabel: '',
  lastNote: '',
};

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let collector = null;

function nowIso() {
  return new Date().toISOString();
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) return fallback;
    return JSON.parse(content);
  } catch (error) {
    console.warn(`读取配置失败: ${error.message}`);
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function loadConfig() {
  return { ...DEFAULT_CONFIG, ...readJsonFile(CONFIG_FILE, {}) };
}

function saveConfigPatch(patch) {
  const config = { ...loadConfig(), ...patch };
  writeJsonFile(CONFIG_FILE, config);
  return config;
}

function cleanLineBuffer(buffer) {
  let startIndex = 0;

  while (startIndex < buffer.length && (buffer[startIndex] === 0xff || buffer[startIndex] === 0x00)) {
    startIndex += 1;
  }

  const filtered = [];
  for (let i = startIndex; i < buffer.length; i += 1) {
    if (buffer[i] !== 0x00) filtered.push(buffer[i]);
  }

  return Buffer.from(filtered).toString('utf8').trim();
}

function extractJsonObjects(line) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0 || line.slice(i, i + 5) === '{"t":') {
        start = i;
        depth = 1;
      } else {
        depth += 1;
      }
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(line.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function parseDecodedPayloads(line) {
  try {
    return [{ raw: line, payload: JSON.parse(line) }];
  } catch (error) {
    return extractJsonObjects(line).map((raw) => {
      try {
        return { raw, payload: JSON.parse(raw) };
      } catch (parseError) {
        return null;
      }
    }).filter(Boolean);
  }
}

function scaledNumber(value, divisor, digits = 2) {
  if (value === undefined || value === null || value === '') return '';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '';
  return Number((numberValue / divisor).toFixed(digits));
}

function rawToCoordinate(rawValue) {
  if (rawValue === undefined || rawValue === null || Number(rawValue) === 0) return '';
  const coordinate = Number(rawValue) / 10000000;
  return Number.isFinite(coordinate) ? Number(coordinate.toFixed(7)) : '';
}

function numberOrEmpty(value) {
  if (value === undefined || value === null || value === '') return '';
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : '';
}

function diff(current, previous) {
  if (current === '' || previous === '' || previous === null || previous === undefined) return '';
  const value = Number(current) - Number(previous);
  return Number.isFinite(value) ? Number(value.toFixed(4)) : '';
}

function csvEscape(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function makeSessionId(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName)) || 'session';
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${baseName}_${stamp}`;
}

function normalizeFileName(fileName) {
  const trimmed = String(fileName || '').trim();
  if (!trimmed) throw new Error('请输入文件名');
  if (/[\\/:*?"<>|]/.test(trimmed)) throw new Error('文件名不能包含 \\ / : * ? " < > |');
  return trimmed.toLowerCase().endsWith('.csv') ? trimmed : `${trimmed}.csv`;
}

function validateStartOptions(body) {
  const saveDir = path.resolve(String(body.saveDir || '').trim());
  const fileName = normalizeFileName(body.fileName);
  const filePath = path.join(saveDir, fileName);
  const baudRate = Number(body.baudRate || DEFAULT_BAUD_RATE);

  if (!String(body.portPath || '').trim()) throw new Error('请选择串口');
  if (!Number.isInteger(baudRate) || baudRate <= 0) throw new Error('波特率不正确');
  if (!['ph', 'turbidity', 'temperature', 'all'].includes(body.targetSensor)) throw new Error('目标传感器不正确');
  if (!['normal', 'abnormal'].includes(body.manualLabel)) throw new Error('标签必须是 normal 或 abnormal');
  if (!String(body.faultType || '').trim()) throw new Error('请输入故障类型，正常数据可填 none');

  return {
    portPath: String(body.portPath).trim(),
    baudRate,
    saveDir,
    fileName,
    filePath,
    overwrite: Boolean(body.overwrite),
    sessionId: String(body.sessionId || '').trim() || makeSessionId(fileName),
    targetSensor: body.targetSensor,
    manualLabel: body.manualLabel,
    faultType: String(body.faultType || '').trim(),
    sceneLabel: String(body.sceneLabel || '').trim(),
    note: String(body.note || '').trim(),
  };
}

class CsvCollector {
  constructor(options) {
    this.options = options;
    this.port = null;
    this.stream = null;
    this.lineBuffer = Buffer.alloc(0);
    this.startedAtMs = Date.now();
    this.startedAt = nowIso();
    this.stoppedAt = null;
    this.rowCount = 0;
    this.rxLineCount = 0;
    this.jsonCount = 0;
    this.parseErrorCount = 0;
    this.lastMessageAt = null;
    this.lastError = null;
    this.lastPreview = null;
    this.previous = null;
  }

  async start() {
    fs.mkdirSync(this.options.saveDir, { recursive: true });
    if (fs.existsSync(this.options.filePath) && !this.options.overwrite) {
      throw new Error(`文件已存在：${this.options.filePath}`);
    }

    this.stream = fs.createWriteStream(this.options.filePath, { flags: 'w', encoding: 'utf8' });
    this.stream.write(`${CSV_COLUMNS.join(',')}\n`);

    this.port = new SerialPort({
      path: this.options.portPath,
      baudRate: this.options.baudRate,
      autoOpen: false,
    });

    this.port.on('data', (chunk) => this.handleChunk(chunk));
    this.port.on('error', (error) => {
      this.lastError = error.message || String(error);
    });
    this.port.on('close', () => {
      if (!this.stoppedAt) this.stoppedAt = nowIso();
    });

    await new Promise((resolve, reject) => {
      this.port.open((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  handleChunk(chunk) {
    this.lineBuffer = Buffer.concat([this.lineBuffer, chunk]);

    while (true) {
      const lineFeedIndex = this.lineBuffer.indexOf(0x0a);
      if (lineFeedIndex === -1) break;

      let line = this.lineBuffer.subarray(0, lineFeedIndex);
      this.lineBuffer = this.lineBuffer.subarray(lineFeedIndex + 1);

      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }

      this.handleLine(cleanLineBuffer(line));
    }
  }

  handleLine(line) {
    if (!line) return;
    this.rxLineCount += 1;
    this.lastMessageAt = nowIso();

    const decoded = parseDecodedPayloads(line);
    if (decoded.length === 0) {
      this.parseErrorCount += 1;
      return;
    }

    for (const item of decoded) {
      this.jsonCount += 1;
      if (item.payload && item.payload.t === 'data') {
        this.writeTelemetryRow(item.payload, item.raw);
      }
    }
  }

  writeTelemetryRow(payload, rawJson) {
    const elapsedMs = Date.now() - this.startedAtMs;
    const row = this.buildRow(payload, rawJson, elapsedMs);
    this.stream.write(`${CSV_COLUMNS.map((column) => csvEscape(row[column])).join(',')}\n`);
    this.rowCount += 1;
    this.lastPreview = row;
    this.previous = {
      timestampMs: row.timestamp_ms,
      ph: row.ph,
      phMv: row.ph_mv,
      turbidity: row.turbidity,
      turbidityMv: row.turbidity_mv,
      temperature: row.temperature,
      yaw: row.yaw,
    };
  }

  buildRow(payload, rawJson, elapsedMs) {
    const ph = scaledNumber(payload.ph, 100);
    const phMv = numberOrEmpty(payload.phmv);
    const turbidity = numberOrEmpty(payload.tb);
    const turbidityMv = numberOrEmpty(payload.tbmv);
    const temperature = Number(payload.tv) === 1 ? scaledNumber(payload.tc, 100) : '';
    const yaw = Number(payload.iv) === 1 ? scaledNumber(payload.iy, 100) : '';
    const timestampMs = elapsedMs;

    return {
      session_id: this.options.sessionId,
      timestamp_iso: nowIso(),
      timestamp_ms: timestampMs,
      target_sensor: this.options.targetSensor,
      manual_label: this.options.manualLabel,
      fault_type: this.options.faultType,
      scene_label: this.options.sceneLabel,
      note: this.options.note,
      seq: payload.seq ?? '',
      uptime_ms: payload.ms ?? '',
      ph,
      ph_raw: payload.phr ?? '',
      ph_mv: phMv,
      turbidity,
      turbidity_raw: payload.tbr ?? '',
      turbidity_mv: turbidityMv,
      turbidity_dout: payload.td ?? '',
      turbidity_valid: payload.tbv ?? '',
      temperature,
      temperature_valid: payload.tv ?? '',
      gps_fix: payload.fix ?? '',
      gps_sat: payload.sat ?? '',
      gps_lat: rawToCoordinate(payload.lat),
      gps_lon: rawToCoordinate(payload.lon),
      imu_valid: payload.iv ?? '',
      roll: Number(payload.iv) === 1 ? scaledNumber(payload.ir, 100) : '',
      pitch: Number(payload.iv) === 1 ? scaledNumber(payload.ip, 100) : '',
      yaw,
      nav_state: payload.ns ?? '',
      nav_distance_m: scaledNumber(payload.nd, 100),
      nav_heading_error_deg: scaledNumber(payload.nt, 100),
      ph_delta: diff(ph, this.previous && this.previous.ph),
      ph_mv_delta: diff(phMv, this.previous && this.previous.phMv),
      turbidity_delta: diff(turbidity, this.previous && this.previous.turbidity),
      turbidity_mv_delta: diff(turbidityMv, this.previous && this.previous.turbidityMv),
      temperature_delta: diff(temperature, this.previous && this.previous.temperature),
      yaw_delta: diff(yaw, this.previous && this.previous.yaw),
      sample_interval_ms: this.previous ? timestampMs - this.previous.timestampMs : '',
      raw_json: rawJson || JSON.stringify(payload),
    };
  }

  async stop() {
    this.stoppedAt = nowIso();

    if (this.port && this.port.isOpen) {
      await new Promise((resolve) => {
        this.port.close(() => resolve());
      });
    }

    if (this.stream) {
      await new Promise((resolve, reject) => {
        this.stream.end((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }

  status() {
    return {
      active: !this.stoppedAt,
      portPath: this.options.portPath,
      baudRate: this.options.baudRate,
      filePath: this.options.filePath,
      sessionId: this.options.sessionId,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      rowCount: this.rowCount,
      rxLineCount: this.rxLineCount,
      jsonCount: this.jsonCount,
      parseErrorCount: this.parseErrorCount,
      partialBytes: this.lineBuffer.length,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      lastPreview: this.lastPreview,
    };
  }
}

function currentStatus() {
  if (!collector) return { active: false };
  return collector.status();
}

app.get('/api/config', (_req, res) => {
  res.json({ config: loadConfig() });
});

app.get('/api/ports', async (_req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json({
      ports: ports.map((port) => ({
        path: port.path,
        manufacturer: port.manufacturer || '',
        friendlyName: port.friendlyName || '',
        serialNumber: port.serialNumber || '',
        vendorId: port.vendorId || '',
        productId: port.productId || '',
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message || String(error) });
  }
});

app.get('/api/status', (_req, res) => {
  res.json(currentStatus());
});

app.post('/api/start', async (req, res) => {
  try {
    if (collector && collector.status().active) throw new Error('当前已经在采集，请先停止');

    const options = validateStartOptions(req.body || {});
    collector = new CsvCollector(options);
    await collector.start();

    saveConfigPatch({
      lastPort: options.portPath,
      lastBaudRate: options.baudRate,
      lastSaveDir: options.saveDir,
      lastFileName: options.fileName,
      lastTargetSensor: options.targetSensor,
      lastManualLabel: options.manualLabel,
      lastFaultType: options.faultType,
      lastSceneLabel: options.sceneLabel,
      lastNote: options.note,
    });

    res.json({ ok: true, status: collector.status() });
  } catch (error) {
    if (collector && collector.status().active) await collector.stop().catch(() => {});
    collector = null;
    res.status(400).json({ message: error.message || String(error) });
  }
});

app.post('/api/stop', async (_req, res) => {
  try {
    if (!collector) {
      res.json({ ok: true, status: currentStatus() });
      return;
    }

    await collector.stop();
    res.json({ ok: true, status: collector.status() });
  } catch (error) {
    res.status(500).json({ message: error.message || String(error) });
  }
});

process.on('SIGINT', async () => {
  if (collector && collector.status().active) {
    console.log('\n正在停止采集并关闭 CSV 文件...');
    await collector.stop().catch((error) => console.error(error));
  }
  process.exit(0);
});

app.listen(HTTP_PORT, () => {
  console.log(`Edge AI CSV Collector: http://localhost:${HTTP_PORT}`);
  console.log('每次点击“开始采集”都会创建一个新的 CSV 文件，点击“停止采集”后文件关闭。');
});
