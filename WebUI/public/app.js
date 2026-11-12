'use strict';

const DEFAULT_MAP_CENTER = [34.5, 104.0];
const DEFAULT_MAP_ZOOM = 4;
const BOAT_FOCUS_ZOOM = 16;
const WS_MAX_RETRIES = 8;
const BUFFER_LIMIT = 30;

const state = {
  status: { connected: false, portPath: null, baudRate: null, partialBytes: 0, lastMessageAt: null },
  latestBoot: null, latestData: null, history: [], logs: [], zones: [], samples: [], latestSampleByZone: {},
  sampling: { status: 'idle', task: null, warning: null, config: {} },
  builtinSpecies: {}, riskAnalyses: {}, llmConfig: { provider: 'disabled', enabled: false },
  selectedZoneId: null, selectedTarget: null, selectedSampleIds: new Set(), creatingZone: false,
  socket: null, wsConnected: false, wsLastAt: null, wsRetries: 0, wsTimer: null,
  telemetryLastAt: null, lastBufferedSeq: null,
  buffers: { ph: [], temp: [], turb: [] },
  aiChat: { messagesByZone: {}, loading: false },
  formDirty: { region: false, sampling: false, llm: false },
  map: { instance: null, tileLayer: null, tileMode: 'standard', boatMarker: null, targetMarker: null, zoneLayers: {}, pointMarkers: [], autoCentered: false, fittedToZones: false, everHadFix: false },
  regionMap: { instance: null, tileLayer: null, draftLayer: null, previewLayer: null, contextLayers: {}, drawing: false, drawStart: null, resetForm: null, focusPending: false },
  gpsTest: { connected: false, portPath: null, baudRate: null, partialBytes: 0, lastSentenceAt: null, sentenceCount: 0, byteCount: 0, checksumErrors: 0, latest: null, lines: [], track: [] },
  gpsTestMap: { instance: null, tileLayer: null, marker: null, trackLine: null, autoCentered: false },
  modalResolve: null, modalLastFocus: null
};

const $ = id => document.getElementById(id);
const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const iconRefresh = () => { if (window.lucide) window.lucide.createIcons(); };
const esc = value => String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const dash = value => value === undefined || value === null || value === '' ? '—' : String(value);
const scaled = (value, divisor, digits = 2) => value === undefined || value === null ? '—' : (Number(value) / divisor).toFixed(digits);
const rawCoord = value => value === undefined || value === null || Number(value) === 0 ? null : Number(value) / 1e7;
const formatCoord = value => value === undefined || value === null || Number.isNaN(Number(value)) ? '—' : Number(value).toFixed(7);
const parseTime = value => { const n = new Date(value || 0).getTime(); return Number.isFinite(n) ? n : 0; };
const formatDate = value => parseTime(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const sourceText = source => ({ serial: '正式采样', manual: '手动采样', advanced_test: '测试样本' })[source] || source || '—';
const sourceClass = source => source === 'manual' ? 'manual' : source === 'advanced_test' ? 'test' : '';
const visibleZones = () => state.zones.filter(zone => !zone.deletedAt);
const deletedZones = () => state.zones.filter(zone => zone.deletedAt);
const getZone = id => state.zones.find(zone => zone.id === id) || null;
const selectedZone = () => { const zone = getZone(state.selectedZoneId); return zone && !zone.deletedAt ? zone : null; };
const latestSample = zoneId => state.latestSampleByZone[zoneId] || state.samples.find(sample => sample.zoneId === zoneId && !sample.deletedAt) || null;
const zoneName = id => getZone(id)?.name || id || '—';
const zoneCenter = zone => zone?.geometry?.center || null;

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', type === 'error' ? 'circle-alert' : type === 'warning' ? 'triangle-alert' : 'circle-check-big');
  const text = document.createElement('p');
  text.textContent = message;
  item.append(icon, text);
  $('toastStack').appendChild(item);
  iconRefresh();
  window.setTimeout(() => item.remove(), 3600);
}

function openConfirm({ title, eyebrow = 'ACTION', message, confirm = '确认', danger = false }) {
  if (state.modalResolve) state.modalResolve(false);
  state.modalLastFocus = document.activeElement;
  $('modalTitle').textContent = title;
  $('modalEyebrow').textContent = eyebrow;
  $('modalContent').textContent = '';
  const p = document.createElement('p'); p.className = 'modal-content-text'; p.textContent = message; $('modalContent').appendChild(p);
  $('modalConfirmBtn').textContent = confirm;
  $('modalConfirmBtn').className = danger ? 'btn danger-outline' : 'btn primary';
  $('modalBackdrop').classList.add('open');
  $('modalBackdrop').setAttribute('aria-hidden', 'false');
  $('modalConfirmBtn').focus();
  return new Promise(resolve => { state.modalResolve = resolve; });
}

function closeModal(result = false) {
  if (!$('modalBackdrop').classList.contains('open')) return;
  $('modalBackdrop').classList.remove('open');
  $('modalBackdrop').setAttribute('aria-hidden', 'true');
  const resolve = state.modalResolve; state.modalResolve = null;
  if (resolve) resolve(result);
  state.modalLastFocus?.focus?.();
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `请求失败 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function applyStatus(payload) {
  const previousZoneId = state.selectedZoneId;
  if (payload.status) state.status = payload.status;
  if ('latestBoot' in payload) state.latestBoot = payload.latestBoot || null;
  if ('latestData' in payload) state.latestData = payload.latestData || null;
  if (Array.isArray(payload.history)) state.history = payload.history;
  if (Array.isArray(payload.logs)) state.logs = payload.logs;
  if (Array.isArray(payload.zones)) state.zones = payload.zones;
  if (Array.isArray(payload.samples)) state.samples = payload.samples;
  if (payload.latestSampleByZone) state.latestSampleByZone = payload.latestSampleByZone;
  if (payload.sampling) state.sampling = payload.sampling;
  if (payload.builtinSpecies) state.builtinSpecies = payload.builtinSpecies;
  if (payload.llmConfig) state.llmConfig = payload.llmConfig;
  if (payload.gpsTest) state.gpsTest = payload.gpsTest;
  if (state.latestData) state.telemetryLastAt = parseTime(payload.latestDataReceivedAt) || state.telemetryLastAt || parseTime(state.status.lastMessageAt) || Date.now();
  ensureSelection();
  if ($('regionForm') && !state.creatingZone && !state.formDirty.region && (previousZoneId !== state.selectedZoneId || !$('regionIdInput').value)) fillRegionForm(selectedZone());
  if (state.creatingZone) ensureCreateSpeciesDefaults();
  pushTelemetryBuffers();
}

function ensureSelection() {
  if (state.creatingZone) { state.selectedZoneId = null; return; }
  const current = getZone(state.selectedZoneId);
  if (!current || current.deletedAt) state.selectedZoneId = visibleZones()[0]?.id || null;
}

function edgeTrustTelemetry(data, key) {
  if (!data) return { text: '等待', level: 'unknown' };
  const value = key === 'ph' ? data.aiphn : data.aitn;
  if (value === undefined || value === null) return { text: '未校验', level: 'warning' };
  return Number(value) === 1 ? { text: '可信', level: 'normal' } : { text: '建议复测', level: 'danger' };
}

function edgeTrustSample(sample, key) {
  const value = key === 'ph' ? sample?.edgeAi?.phNormal : sample?.edgeAi?.temperatureNormal;
  if (value === undefined || value === null) return { text: '未校验', level: 'unknown' };
  return value ? { text: '可信', level: 'normal' } : { text: '建议复测', level: 'warning' };
}

function riskLevel(sample, zone) {
  if (!sample) return { level: 'unknown', label: '未采样', hint: '该区域暂无持久化采样数据。' };
  const thresholds = zone?.speciesProfile?.thresholds;
  if (!thresholds) return { level: 'unknown', label: '无阈值', hint: '该区域尚未配置完整阈值。' };
  const water = sample.water || {};
  const phTrust = edgeTrustSample(sample, 'ph');
  const tempTrust = edgeTrustSample(sample, 'temperature');
  if (phTrust.level === 'warning' || tempTrust.level === 'warning') return { level: 'warning', label: '需复测', hint: '边缘 AI 标记部分数据需要复测。' };
  if (water.ph == null || water.tempC == null) return { level: 'unknown', label: '数据不全', hint: '样本缺少 pH 或水温，无法完成规则判断。' };
  /* 浊度传感器已停用：只有确实采到数值时才参与判断 */
  const turbOver = water.turbidity != null && water.turbidity > thresholds.turbidityMax * 1.25;
  const turbNear = water.turbidity != null && water.turbidity > thresholds.turbidityMax;
  if (water.ph < thresholds.phMin || water.ph > thresholds.phMax || water.tempC < thresholds.tempMin || water.tempC > thresholds.tempMax || turbOver) return { level: 'danger', label: '危险', hint: '至少一项指标明显超出适宜范围。' };
  if (water.ph < thresholds.phMin + .2 || water.ph > thresholds.phMax - .2 || water.tempC < thresholds.tempMin + 1 || water.tempC > thresholds.tempMax - 1 || turbNear) return { level: 'warning', label: '预警', hint: '至少一项指标接近或略超阈值。' };
  return { level: 'normal', label: '正常', hint: '当前持久化样本位于配置阈值内。' };
}

const phaseText = phase => ({ dispatching_target: '正在下发目标', navigating: '前往中', stabilizing: '稳定中', sampling: '采样中', paused_warning: '警告暂停', cancelling: '正在取消', completed: '已完成', cancelled: '已取消' })[phase] || '待机';
const phaseIndex = phase => ({ dispatching_target: 0, navigating: 1, stabilizing: 2, sampling: 3, paused_warning: 1, cancelling: 1, completed: 4 })[phase] ?? -1;
const activeTask = () => state.sampling.task && ['dispatching_target', 'navigating', 'stabilizing', 'sampling', 'paused_warning', 'cancelling'].includes(state.sampling.task.phase);
const navStateText = value => ({ 0: '待机', 1: '导航中', 2: '区域保持', 3: 'GPS 丢失', 4: '越界归位', 5: '航向测试' })[value] ?? (value == null ? '—' : `未知(${value})`);
const boundaryStateText = value => ({ 0: '未启用', 1: '边界内', 2: '接近边界', 3: '已越界' })[value] ?? (value == null ? '—' : `未知(${value})`);
const returnStateText = value => ({ 0: '未归位', 1: '归位中', 2: '已回归' })[value] ?? (value == null ? '—' : `未知(${value})`);

function freshness(timestamp) {
  if (!timestamp) return { level: 'stale', label: '等待', age: '—' };
  const ageMs = Math.max(0, Date.now() - timestamp);
  const age = ageMs < 1000 ? '刚刚' : ageMs < 60000 ? `${Math.floor(ageMs / 1000)} 秒前` : `${Math.floor(ageMs / 60000)} 分钟前`;
  if (ageMs < 3000) return { level: 'fresh', label: '新鲜', age };
  if (ageMs <= 10000) return { level: 'delayed', label: '延迟', age };
  return { level: 'stale', label: '陈旧', age };
}

function renderFreshness() {
  const ws = state.wsConnected ? freshness(state.wsLastAt || Date.now()) : { level: 'stale', label: '重连中', age: state.wsLastAt ? freshness(state.wsLastAt).age : '—' };
  const serialAt = parseTime(state.status.lastMessageAt);
  const serial = state.status.connected ? freshness(serialAt) : { level: 'stale', label: '未连接', age: '—' };
  const telemetry = state.latestData ? freshness(state.telemetryLastAt || serialAt) : { level: 'stale', label: '等待数据', age: '—' };
  $('wsStatusText').textContent = state.wsConnected ? `已连接 · ${ws.label}` : ws.label;
  $('wsAge').textContent = ws.age;
  $('serialStatusText').textContent = state.status.connected ? `已连接 · ${serial.label}` : '未连接';
  $('serialPortText').textContent = state.status.connected ? `${state.status.portPath || '—'} · ${state.status.baudRate || '—'}` : '—';
  $('dataStatusText').textContent = state.latestData ? `${telemetry.label}${telemetry.level === 'stale' ? '（保留末值）' : ''}` : '等待数据';
  $('dataAge').textContent = telemetry.age;
  $('telemetryFreshChip').className = `freshness-chip ${telemetry.level}`;
  $('telemetryFreshText').textContent = telemetry.label;
  $('messageAge').textContent = state.latestData ? `${telemetry.age}${telemetry.level === 'stale' ? ' · 陈旧' : ''}` : '等待';
  $('connectionWs').textContent = state.wsConnected ? `已连接 · ${ws.label}` : ws.label;
  $('connectionWsDetail').textContent = state.wsConnected ? `最后事件 ${ws.age}` : `已重连 ${state.wsRetries} 次 · 将继续尝试`;
  $('connectionSerial').textContent = state.status.connected ? `已连接 · ${serial.label}` : '未连接';
  $('connectionTelemetry').textContent = state.latestData ? telemetry.label : '等待';
  $('connectionLastData').textContent = state.latestData ? telemetry.age : '—';
  $('connectedLastMessage').textContent = `最后消息：${serial.age}`;
  $('globalStopBtn').disabled = !state.status.connected;
}

function setTrust(id, trust) { const element = $(id); element.textContent = trust.text; element.className = `trust ${trust.level}`; }
function setRiskBadge(element, risk) { element.textContent = risk.label; element.className = `risk-badge ${risk.level}`; }
function formatUptime(ms) { if (ms == null) return '—'; const seconds = Math.floor(Number(ms) / 1000); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); return `${hours}h ${minutes}m ${seconds % 60}s`; }

function pushTelemetryBuffers() {
  const data = state.latestData;
  if (!data) return;
  const key = data.seq ?? state.telemetryLastAt;
  if (key === state.lastBufferedSeq) return;
  state.lastBufferedSeq = key;
  const values = { ph: data.ph == null ? null : Number(data.ph) / 100, temp: Number(data.tv) === 1 && data.tc != null ? Number(data.tc) / 100 : null, turb: data.tb == null ? null : Number(data.tb) };
  for (const [name, value] of Object.entries(values)) {
    if (Number.isFinite(value)) { state.buffers[name].push(value); state.buffers[name] = state.buffers[name].slice(-BUFFER_LIMIT); }
  }
}

function renderSparkline(id, values, color) {
  const root = $(id); root.textContent = '';
  if (!values.length) { const empty = document.createElement('div'); empty.className = 'spark-empty'; empty.textContent = '等待会话遥测'; root.appendChild(empty); return; }
  const width = 240, height = 38, min = Math.min(...values), max = Math.max(...values);
  const points = values.map((value, index) => `${values.length === 1 ? width / 2 : index * width / (values.length - 1)},${height - 5 - (value - min) / (max - min || 1) * (height - 12)}`).join(' ');
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><line class="grid" x1="0" y1="31" x2="240" y2="31"></line><polygon class="area" fill="${color}" points="0,38 ${points} 240,38"></polygon><polyline stroke="${color}" points="${points}"></polyline></svg>`;
}

function renderKpis() {
  const data = state.latestData;
  const zone = selectedZone();
  const thresholds = zone?.speciesProfile?.thresholds;
  const ph = data?.ph == null ? null : Number(data.ph) / 100;
  const temp = data && Number(data.tv) === 1 && data.tc != null ? Number(data.tc) / 100 : null;
  const turb = data?.tb == null ? null : Number(data.tb);
  $('phValue').textContent = ph == null ? '—' : ph.toFixed(2);
  $('tempValue').textContent = temp == null ? '—' : temp.toFixed(2);
  $('turbidityValue').textContent = turb == null ? '—' : dash(turb);
  setTrust('phTrust', edgeTrustTelemetry(data, 'ph'));
  setTrust('tempTrust', edgeTrustTelemetry(data, 'temperature'));
  setTrust('turbTrust', !data ? { text: '等待', level: 'unknown' } : data.tbv === undefined ? { text: '未接入', level: 'unknown' } : { text: Number(data.tbv) === 1 ? '有效' : '无效', level: Number(data.tbv) === 1 ? 'normal' : 'warning' });
  $('phRange').textContent = thresholds ? `适宜 ${thresholds.phMin}–${thresholds.phMax}` : '选择区域后显示阈值';
  $('tempRange').textContent = thresholds ? `适宜 ${thresholds.tempMin}–${thresholds.tempMax}°C` : '选择区域后显示阈值';
  $('turbRange').textContent = thresholds ? `上限 ${thresholds.turbidityMax} NTU` : '选择区域后显示阈值';
  $('phState').textContent = ph == null ? '等待' : !thresholds ? '无阈值' : ph < thresholds.phMin || ph > thresholds.phMax ? '超出' : '范围内';
  $('tempState').textContent = temp == null ? '等待' : !thresholds ? '无阈值' : temp < thresholds.tempMin || temp > thresholds.tempMax ? '超出' : '范围内';
  $('turbState').textContent = turb == null ? '等待' : !thresholds ? '无阈值' : turb > thresholds.turbidityMax ? '超出' : '范围内';
  const ns = data?.ns;
  $('navTrust').textContent = navStateText(ns); $('navTrust').className = `trust ${ns === 3 ? 'danger' : ns === 4 ? 'warning' : ns === 1 || ns === 2 ? 'normal' : 'unknown'}`;
  const navActive = Number(ns) > 0 && Number(ns) !== 3;   /* 3 = GPS 丢失，此时 nd/nt 无意义 */
  $('distanceValue').textContent = data?.nd != null && navActive ? scaled(data.nd, 100) : '—';
  $('yawValue').textContent = data && Number(data.iv) === 1 && data.iy != null ? `${scaled(data.iy, 100, 1)}°` : '—';
  $('headingError').textContent = data?.nt != null && navActive ? `${scaled(data.nt, 100, 1)}°` : '—';
  if ($('boundaryState')) $('boundaryState').textContent = data?.bs != null ? `边界 ${boundaryStateText(data.bs)}${data.bd != null ? ` · ${scaled(data.bd, 100)}m` : ''}` : '边界 —';
  if ($('returnState')) $('returnState').textContent = data?.rs != null ? returnStateText(data.rs) : '归位 —';
  $('navProgress').style.width = activeTask() && data?.nd != null ? `${Math.max(6, Math.min(100, 100 - Number(data.nd) / 100))}%` : '0%';
  renderSparkline('phSpark', state.buffers.ph, '#477a55'); renderSparkline('tempSpark', state.buffers.temp, '#a86625'); renderSparkline('turbSpark', state.buffers.turb, '#4f898c');
}

function renderTelemetry() {
  const data = state.latestData;
  $('packetNo').textContent = dash(data?.seq);
  $('gpsSummary').textContent = data ? `${Number(data.fix) > 0 ? `已定位(${data.fix})` : '未定位'} / ${dash(data.sat)}` : '—';
  $('gpsCoords').textContent = data ? `${formatCoord(rawCoord(data.lat))} / ${formatCoord(rawCoord(data.lon))}` : '—';
  $('imuSummary').textContent = data ? `${Number(data.iv) === 1 ? '有效' : '无效'} / ${Number(data.iv) === 1 ? scaled(data.ir, 100, 1) : '—'}° / ${Number(data.iv) === 1 ? scaled(data.ip, 100, 1) : '—'}°` : '—';
  if (data) {
    const boundary = data.bs != null ? ` / 边界 ${boundaryStateText(data.bs)}${data.bd != null ? ' ' + scaled(data.bd, 100) + 'm' : ''}` : '';
    const returning = data.rs != null ? ` / ${returnStateText(data.rs)}${data.rd != null && Number(data.rs) > 0 ? ' ' + scaled(data.rd, 100) + 'm' : ''}` : '';
    $('navSummary').textContent = `${navStateText(data.ns)} / ${data.nd != null && Number(data.ns) > 0 ? scaled(data.nd, 100) + 'm' : '—'} / ${data.nt != null && Number(data.ns) > 0 ? scaled(data.nt, 100, 1) + '°' : '—'}${boundary}${returning}`;
  } else $('navSummary').textContent = '—';
  $('uptimeValue').textContent = formatUptime(data?.ms);
}

function geometryBounds(geometry) {
  const center = geometry?.center;
  const latitude = Number(center?.latitude), longitude = Number(center?.longitude), lengthM = Number(geometry?.lengthM), widthM = Number(geometry?.widthM);
  if (![latitude, longitude, lengthM, widthM].every(Number.isFinite) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || lengthM <= 0 || widthM <= 0) return null;
  const metersLat = 111320, metersLon = Math.max(1, 111320 * Math.abs(Math.cos(latitude * Math.PI / 180)));
  const halfLength = lengthM / 2 / metersLat, halfWidth = widthM / 2 / metersLon;
  return [[latitude - halfLength, longitude - halfWidth], [latitude + halfLength, longitude + halfWidth]];
}

function rectBounds(zone) { return geometryBounds(zone?.geometry); }

function boundsToGeometry(bounds) {
  const center = bounds.getCenter(), north = bounds.getNorth(), south = bounds.getSouth(), east = bounds.getEast(), west = bounds.getWest();
  const metersLon = Math.max(1, 111320 * Math.abs(Math.cos(center.lat * Math.PI / 180)));
  return { center: { latitude: +center.lat.toFixed(7), longitude: +center.lng.toFixed(7) }, lengthM: +((north - south) * 111320).toFixed(1), widthM: +((east - west) * metersLon).toFixed(1) };
}

function regionGeometryFromInputs() {
  const geometry = { center: { latitude: Number($('zoneLatInput').value), longitude: Number($('zoneLonInput').value) }, lengthM: Number($('zoneLengthInput').value), widthM: Number($('zoneWidthInput').value) };
  return geometryBounds(geometry) ? geometry : null;
}

function setRegionGeometryInputs(geometry) {
  $('zoneLatInput').value = Number(geometry.center.latitude).toFixed(7);
  $('zoneLonInput').value = Number(geometry.center.longitude).toFixed(7);
  $('zoneLengthInput').value = Number(geometry.lengthM).toFixed(1);
  $('zoneWidthInput').value = Number(geometry.widthM).toFixed(1);
  state.formDirty.region = true;
  syncRegionMapFromForm(false);
}

function updateRegionMapStatus(geometry = regionGeometryFromInputs()) {
  if (!$('regionMapStatus')) return;
  $('regionMapStatus').textContent = geometry ? `当前区域：${Number(geometry.lengthM).toFixed(1)} m × ${Number(geometry.widthM).toFixed(1)} m · 中心 ${Number(geometry.center.latitude).toFixed(7)}, ${Number(geometry.center.longitude).toFixed(7)}` : '请输入有效的中心坐标和区域尺寸';
  $('fitRegionBtn').disabled = !geometry;
}

function focusRegionGeometry(geometry = regionGeometryFromInputs()) {
  const map = state.regionMap.instance, bounds = geometryBounds(geometry);
  if (map && bounds) map.fitBounds(bounds, { padding: [34, 34], maxZoom: 18 });
}

function renderRegionMapContext() {
  const map = state.regionMap.instance; if (!map || typeof L === 'undefined') return;
  const visibleIds = new Set(visibleZones().filter(zone => zone.id !== state.selectedZoneId).map(zone => zone.id));
  for (const [id, layer] of Object.entries(state.regionMap.contextLayers)) if (!visibleIds.has(id)) { map.removeLayer(layer); delete state.regionMap.contextLayers[id]; }
  for (const zone of visibleZones()) {
    if (zone.id === state.selectedZoneId) continue;
    const bounds = rectBounds(zone); if (!bounds) continue;
    let layer = state.regionMap.contextLayers[zone.id];
    const style = { color: '#968b7c', weight: 1, dashArray: '5 5', fillColor: '#ddcfbb', fillOpacity: .08, interactive: false };
    if (!layer) { layer = L.rectangle(bounds, style).addTo(map); state.regionMap.contextLayers[zone.id] = layer; }
    else layer.setBounds(bounds).setStyle(style);
  }
}

function syncRegionMapFromForm(focus = false) {
  const map = state.regionMap.instance; if (!map || typeof L === 'undefined') return;
  const geometry = regionGeometryFromInputs(), bounds = geometryBounds(geometry);
  if (!bounds) {
    if (state.regionMap.draftLayer) { map.removeLayer(state.regionMap.draftLayer); state.regionMap.draftLayer = null; }
    updateRegionMapStatus(null); return;
  }
  const style = { color: '#4f898c', weight: 3, fillColor: '#4f898c', fillOpacity: .2, dashArray: state.creatingZone ? '7 5' : null, interactive: false };
  if (!state.regionMap.draftLayer) state.regionMap.draftLayer = L.rectangle(bounds, style).addTo(map); else state.regionMap.draftLayer.setBounds(bounds).setStyle(style);
  state.regionMap.draftLayer.bringToFront(); updateRegionMapStatus(geometry); if (focus) focusRegionGeometry(geometry);
}

function stopRegionDrawing(cancelled = false) {
  const map = state.regionMap.instance; state.regionMap.drawing = false; state.regionMap.drawStart = null;
  if (map && state.regionMap.previewLayer) { map.removeLayer(state.regionMap.previewLayer); state.regionMap.previewLayer = null; }
  map?.dragging.enable(); map?.doubleClickZoom.enable();
  $('regionMapCanvas')?.classList.remove('drawing'); $('drawRegionBtn')?.setAttribute('aria-pressed', 'false');
  if ($('drawRegionBtn')) $('drawRegionBtn').querySelector('span').textContent = '绘制区域';
  if ($('regionMapHelp')) $('regionMapHelp').textContent = cancelled ? '已取消本次绘制，原区域范围保持不变。' : '点击“绘制区域”，然后在地图上按住并拖动形成矩形；也可以直接修改下方参数。';
}

function startRegionDrawing() {
  ensureRegionMap(); const map = state.regionMap.instance; if (!map) return;
  if (state.regionMap.drawing) return stopRegionDrawing(true);
  state.regionMap.drawing = true; state.regionMap.drawStart = null; map.dragging.disable(); map.doubleClickZoom.disable();
  $('regionMapCanvas').classList.add('drawing'); $('drawRegionBtn').setAttribute('aria-pressed', 'true'); $('drawRegionBtn').querySelector('span').textContent = '取消绘制';
  $('regionMapHelp').textContent = '请在地图上按住并拖动以确定矩形范围，松开后完成。按 Esc 可取消。';
}

function ensureRegionMap() {
  if (state.regionMap.instance || typeof L === 'undefined' || !$('regionMapCanvas')) return;
  const map = L.map('regionMapCanvas', { zoomControl: true, attributionControl: false, keyboard: true }).setView(DEFAULT_MAP_CENTER, 16);
  const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }); tileLayer.addTo(map);
  tileLayer.on('tileerror', () => $('regionMapCanvas').classList.add('no-tiles')); tileLayer.on('load', () => $('regionMapCanvas').classList.remove('no-tiles'));
  map.on('mousedown', event => {
    if (!state.regionMap.drawing) return;
    state.regionMap.drawStart = event.latlng;
    if (state.regionMap.previewLayer) map.removeLayer(state.regionMap.previewLayer);
    state.regionMap.previewLayer = L.rectangle(L.latLngBounds(event.latlng, event.latlng), { color: '#4f898c', weight: 2, dashArray: '6 4', fillColor: '#4f898c', fillOpacity: .16, interactive: false }).addTo(map);
  });
  map.on('mousemove', event => {
    if (!state.regionMap.drawing || !state.regionMap.drawStart || !state.regionMap.previewLayer) return;
    const bounds = L.latLngBounds(state.regionMap.drawStart, event.latlng); state.regionMap.previewLayer.setBounds(bounds);
    const geometry = boundsToGeometry(bounds); $('regionMapStatus').textContent = `正在绘制：${geometry.lengthM.toFixed(1)} m × ${geometry.widthM.toFixed(1)} m`;
  });
  map.on('mouseup', event => {
    if (!state.regionMap.drawing || !state.regionMap.drawStart) return;
    const bounds = L.latLngBounds(state.regionMap.drawStart, event.latlng), geometry = boundsToGeometry(bounds);
    if (geometry.lengthM < .1 || geometry.widthM < .1) { toast('绘制范围过小，请按住并拖动形成矩形', 'warning'); stopRegionDrawing(true); syncRegionMapFromForm(false); return; }
    setRegionGeometryInputs(geometry); stopRegionDrawing(false); focusRegionGeometry(geometry);
  });
  state.regionMap.instance = map; state.regionMap.tileLayer = tileLayer; renderRegionMapContext(); syncRegionMapFromForm(false);
}

function boatCoords() {
  const data = state.latestData; if (!data || Number(data.fix) <= 0) return null;
  const latitude = rawCoord(data.lat), longitude = rawCoord(data.lon);
  return latitude == null || longitude == null ? null : { latitude, longitude };
}

function ensureMap() {
  if (state.map.instance || typeof L === 'undefined') return;
  const map = L.map('mapCanvas', { zoomControl: true, attributionControl: false }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
  const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
  tileLayer.addTo(map);
  tileLayer.on('tileerror', () => $('mapCanvas').classList.add('no-tiles'));
  tileLayer.on('load', () => { if (state.map.tileMode === 'standard') $('mapCanvas').classList.remove('no-tiles'); });
  map.on('click', event => { state.selectedTarget = { latitude: +event.latlng.lat.toFixed(7), longitude: +event.latlng.lng.toFixed(7) }; renderMap(); renderTargetControls(); });
  state.map.instance = map; state.map.tileLayer = tileLayer;
}

function zoneTooltip(zone) {
  const sample = latestSample(zone.id), risk = riskLevel(sample, zone), water = sample?.water || {};
  return `<strong>${esc(zone.name)} · ${esc(risk.label)}</strong><span>${esc(zone.speciesProfile?.label || '—')} · pH ${esc(water.ph ?? '—')} · ${esc(water.tempC ?? '—')}°C · 浊度 ${esc(water.turbidity ?? '—')}</span>`;
}

function renderMap() {
  ensureMap(); const map = state.map.instance; if (!map || typeof L === 'undefined') return;
  const visibleIds = new Set(visibleZones().map(zone => zone.id));
  for (const [id, layer] of Object.entries(state.map.zoneLayers)) if (!visibleIds.has(id)) { map.removeLayer(layer); delete state.map.zoneLayers[id]; }
  for (const zone of visibleZones()) {
    const bounds = rectBounds(zone); if (!bounds) continue;
    const risk = riskLevel(latestSample(zone.id), zone); const selected = zone.id === state.selectedZoneId;
    const color = ({ normal: '#477a55', warning: '#a86625', danger: '#ad4842', unknown: '#968b7c' })[risk.level];
    const style = { color: selected ? '#4f898c' : color, weight: selected ? 4 : 2, fillColor: color, fillOpacity: selected ? .25 : .13, bubblingMouseEvents: false };
    let layer = state.map.zoneLayers[zone.id];
    if (!layer) { layer = L.rectangle(bounds, style).addTo(map); layer.bindTooltip(zoneTooltip(zone), { permanent: true, direction: 'center', className: 'zone-map-label', opacity: 1 }); layer.on('click', () => selectZone(zone.id)); state.map.zoneLayers[zone.id] = layer; }
    else { layer.setBounds(bounds).setStyle(style); layer.getTooltip()?.setContent(zoneTooltip(zone)); }
  }
  state.map.pointMarkers.forEach(marker => map.removeLayer(marker)); state.map.pointMarkers = [];
  const task = state.sampling.task;
  if (Array.isArray(task?.samplePoints)) task.samplePoints.forEach((point, index) => {
    const current = index === Number(task.currentPointIndex || 0), past = index < Number(task.currentPointIndex || 0);
    const icon = L.divIcon({ className: '', html: `<div style="width:${current ? 18 : 14}px;height:${current ? 18 : 14}px;border-radius:50%;display:grid;place-items:center;background:${current ? '#4f898c' : past ? '#477a55' : '#968b7c'};color:white;border:2px solid #fff;font:8px sans-serif">${index + 1}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
    state.map.pointMarkers.push(L.marker([point.latitude, point.longitude], { icon }).addTo(map));
  });
  const boat = boatCoords();
  if (boat) {
    const latLng = [boat.latitude, boat.longitude];
    if (!state.map.boatMarker) state.map.boatMarker = L.circleMarker(latLng, { radius: 8, color: '#fff', weight: 3, fillColor: '#4f898c', fillOpacity: 1 }).addTo(map).bindTooltip('无人船'); else state.map.boatMarker.setLatLng(latLng);
    /* 有定位就以船为准：
     *   第一次拿到定位        -> 直接居中到船
     *   之后船跑出当前视野    -> 自动跟过去
     * 之前只居中一次，且若页面先无定位把视野落到了区域上（可能在几百公里外），
     * 定位回来时也不会切回来，地图就一直停在错误的位置。 */
    if (!state.map.autoCentered) {
      map.setView(latLng, BOAT_FOCUS_ZOOM);
      state.map.autoCentered = true;
    } else if (!map.getBounds().contains(latLng)) {
      map.setView(latLng, Math.max(map.getZoom(), BOAT_FOCUS_ZOOM));
    }
    state.map.fittedToZones = false;   /* 有定位时不再"缩放到区域" */
    state.map.everHadFix = true;       /* 定位过之后就再也不跳到区域上 */
    $('mapCoordinate').textContent = `船位 ${boat.latitude.toFixed(7)}, ${boat.longitude.toFixed(7)}`;
  } else {
    if (state.map.boatMarker) { map.removeLayer(state.map.boatMarker); state.map.boatMarker = null; }
    state.map.autoCentered = false;
    /* 没有船位时（室内无 GPS 就是这样）把视野落到区域上。
     * 默认视野是 zoom 4（整个东亚），而区域只有 20×10 米——
     * 那样区域在地图上只有一个像素，既看不见也点不中。 */
    /* 只在"从来没拿到过定位"时才把视野落到区域上。
     * 一旦定位过，GPS 短暂掉线时保持当前视野，否则地图会突然跳回
     * 区域所在的位置（可能几百公里外），水面上完全没法用。 */
    if (!state.map.fittedToZones && !state.map.everHadFix) {
      const acc = L.latLngBounds([]);
      for (const zone of visibleZones()) {
        const b = rectBounds(zone);
        if (b) { acc.extend(b[0]); acc.extend(b[1]); }
      }
      if (acc.isValid()) {
        map.fitBounds(acc.pad(0.4), { maxZoom: 18 });
        state.map.fittedToZones = true;
      }
    }
    $('mapCoordinate').textContent = '船位 —';
  }
  if (state.selectedTarget) {
    const latLng = [state.selectedTarget.latitude, state.selectedTarget.longitude];
    if (!state.map.targetMarker) state.map.targetMarker = L.circleMarker(latLng, { radius: 7, color: '#fff', weight: 3, fillColor: '#ad4842', fillOpacity: 1 }).addTo(map).bindTooltip('目标点'); else state.map.targetMarker.setLatLng(latLng);
  } else if (state.map.targetMarker) { map.removeLayer(state.map.targetMarker); state.map.targetMarker = null; }
}

function renderTargetControls() {
  $('targetSummary').textContent = state.selectedTarget ? `目标 ${state.selectedTarget.latitude.toFixed(7)}, ${state.selectedTarget.longitude.toFixed(7)}` : '尚未选择地图目标';
  $('sendMapTargetBtn').disabled = !state.selectedTarget || !state.status.connected || Boolean(activeTask());
}

function selectZone(id) { beginEditRegion(id, true); }

function renderRegionSummary() {
  const zone = selectedZone();
  if (!zone) {
    $('regionName').textContent = '等待区域'; $('regionSpecies').textContent = '—'; $('regionSampleTime').textContent = '—'; $('regionPh').textContent = '—'; $('regionTemp').textContent = '—'; $('regionTurbidity').textContent = '—';
    setRiskBadge($('regionRisk'), { level: 'unknown', label: '未选择' }); $('riskReason').querySelector('strong').textContent = '等待数据'; $('riskReason').querySelector('span').textContent = '选择区域并等待真实采样数据。'; return;
  }
  const sample = latestSample(zone.id), risk = riskLevel(sample, zone), water = sample?.water || {};
  $('regionName').textContent = zone.name; $('regionSpecies').textContent = zone.speciesProfile?.label || '—'; $('regionSampleTime').textContent = sample ? formatDate(sample.savedAt || sample.receivedAt) : '未采样';
  $('regionPh').textContent = dash(water.ph); $('regionTemp').textContent = water.tempC == null ? '—' : `${water.tempC}°C`; $('regionTurbidity').textContent = dash(water.turbidity); setRiskBadge($('regionRisk'), risk);
  $('riskReason').querySelector('strong').textContent = risk.label; $('riskReason').querySelector('span').textContent = risk.hint;
}

function renderMission() {
  const task = state.sampling.task, active = activeTask(), phase = task?.phase;
  const warning = state.sampling.warning;
  $('missionTitle').textContent = task ? `${zoneName(task.zoneId)} 巡检` : '当前无任务'; $('missionPhase').textContent = phaseText(phase);
  $('missionPoint').textContent = task?.samplePoints?.length ? `采样点 ${(Number(task.currentPointIndex) || 0) + 1}/${task.samplePoints.length}` : '—';
  $('cancelTaskBtn').disabled = !active; $('taskCancelBtn').disabled = !active; $('taskCount').textContent = active ? '1' : '0';
  const index = phaseIndex(phase); const pieces = qsa('#missionStage span, #missionStage i'); pieces.forEach((piece, pieceIndex) => piece.classList.toggle('active', pieceIndex <= index * 2));
  const warningText = warning ? (typeof warning === 'string' ? warning : warning.code || warning.message || JSON.stringify(warning)) : '';
  const canRetry = warningText.includes('target_send_failed');
  for (const id of ['missionWarning', 'taskWarning']) { const node = $(id); node.hidden = !warningText; node.textContent = warningText ? `任务警告：${warningText}` : ''; }
  $('retryTargetBtn').hidden = !canRetry; $('taskRetryBtn').hidden = !canRetry;
  $('taskViewTitle').textContent = task ? `任务 ${task.id || ''}`.trim() : '当前无任务'; setRiskBadge($('taskViewBadge'), { level: phase === 'paused_warning' ? 'warning' : active ? 'normal' : 'unknown', label: phaseText(phase) });
  $('taskZoneName').textContent = task ? zoneName(task.zoneId) : '—';
  $('taskDetailText').textContent = task ? `${phaseText(phase)}${task.samplePoints?.length ? ` · 点位 ${(Number(task.currentPointIndex) || 0) + 1}/${task.samplePoints.length}` : ''}` : '等待任务';
  const stages = [{ key: 'dispatching_target', label: '下发导航目标' }, { key: 'navigating', label: '前往区域/采样点' }, { key: 'stabilizing', label: '等待船体与传感器稳定' }, { key: 'sampling', label: '按间隔连续采样' }];
  $('taskTimeline').innerHTML = stages.map((stage, i) => `<div class="${index > i ? 'done' : index === i ? 'active' : ''}"><i>${index > i ? '✓' : i + 1}</i><p><strong>${stage.label}</strong><span>${index === i ? phaseText(phase) : index > i ? '已完成' : '等待'}</span></p></div>`).join('');
}

function renderZoneLists() {
  const filter = $('regionSearch').value.trim().toLowerCase();
  const zones = visibleZones().filter(zone => `${zone.name} ${zone.speciesProfile?.label || ''}`.toLowerCase().includes(filter));
  $('zoneCount').textContent = visibleZones().length;
  $('regionList').innerHTML = zones.length ? zones.map(zone => { const risk = riskLevel(latestSample(zone.id), zone); return `<button class="region-list-item ${zone.id === state.selectedZoneId ? 'active' : ''}" data-zone-id="${esc(zone.id)}"><div><strong>${esc(zone.name)}</strong><span class="risk-badge ${risk.level}">${esc(risk.label)}</span></div><p>${esc(zone.speciesProfile?.label || '—')} · ${esc(latestSample(zone.id) ? formatDate(latestSample(zone.id).savedAt || latestSample(zone.id).receivedAt) : '未采样')}</p></button>`; }).join('') : '<p class="empty-state">暂无匹配区域</p>';
  const deleted = deletedZones(); $('deletedZoneSelect').innerHTML = deleted.length ? deleted.map(zone => `<option value="${esc(zone.id)}">${esc(zone.name)}</option>`).join('') : '<option value="">无可恢复区域</option>'; $('recoverZoneBtn').disabled = !deleted.length;
  const currentFilter = $('sampleFilter').value; $('sampleFilter').innerHTML = '<option value="">全部区域</option>' + visibleZones().map(zone => `<option value="${esc(zone.id)}">${esc(zone.name)}</option>`).join(''); if (getZone(currentFilter)) $('sampleFilter').value = currentFilter;
}

const REGION_FORM_IDS = ['regionIdInput','zoneNameInput','speciesModeSelect','builtinSpeciesSelect','customSpeciesInput','zoneLatInput','zoneLonInput','zoneLengthInput','zoneWidthInput','phMinInput','phMaxInput','tempMinInput','tempMaxInput','turbidityMaxInput'];

function captureRegionForm() { return Object.fromEntries(REGION_FORM_IDS.map(id => [id, $(id).value])); }
function restoreRegionForm(values) { if (!values) return; for (const id of REGION_FORM_IDS) if (id in values) $(id).value = values[id]; updateSpeciesForm(false); state.formDirty.region = false; syncRegionMapFromForm(true); }

function getNewRegionDefaults(baseZone = selectedZone()) {
  const center = zoneCenter(baseZone) || boatCoords() || { latitude: DEFAULT_MAP_CENTER[0], longitude: DEFAULT_MAP_CENTER[1] };
  const speciesKey = Object.keys(state.builtinSpecies)[0] || '';
  return { center, lengthM: 20, widthM: 10, speciesKey };
}

function beginCreateRegion() {
  const defaults = getNewRegionDefaults(selectedZone());
  state.creatingZone = true; state.selectedZoneId = null; state.selectedSampleIds.clear();
  fillRegionForm(null, defaults); state.regionMap.resetForm = captureRegionForm(); state.regionMap.focusPending = true;
  navigate('regions'); render(); setTimeout(() => { ensureRegionMap(); state.regionMap.instance?.invalidateSize(); syncRegionMapFromForm(true); $('zoneNameInput').focus(); }, 120);
}

function beginEditRegion(id, shouldRender = false) {
  const zone = getZone(id); if (!zone || zone.deletedAt) return;
  state.creatingZone = false; state.selectedZoneId = id; state.selectedSampleIds.clear();
  const center = zoneCenter(zone); if (center) state.selectedTarget = { latitude: center.latitude, longitude: center.longitude };
  fillRegionForm(zone); state.regionMap.resetForm = captureRegionForm(); state.regionMap.focusPending = true;
  if (shouldRender) render();
  const bounds = rectBounds(zone); if (bounds) state.map.instance?.fitBounds(bounds, { padding: [30, 30], maxZoom: 18 });
  setTimeout(() => { ensureRegionMap(); state.regionMap.instance?.invalidateSize(); renderRegionMapContext(); syncRegionMapFromForm(true); }, 100);
}

function resetRegionEditor() { restoreRegionForm(state.regionMap.resetForm); toast(state.creatingZone ? '已恢复新建区域默认范围' : '已恢复上次保存的区域配置'); }

function fillRegionForm(zone = selectedZone(), defaults = null) {
  state.formDirty.region = false;
  $('regionEditorTitle').textContent = state.creatingZone ? '新建区域' : zone ? `编辑 · ${zone.name}` : '区域配置'; $('deleteRegionBtn').disabled = !zone || state.creatingZone;
  $('regionIdInput').value = zone?.id || ''; $('zoneNameInput').value = zone?.name || '';
  $('speciesModeSelect').value = zone?.speciesProfile?.type || 'builtin'; renderBuiltinSpecies();
  const speciesKey = zone?.speciesProfile?.key || defaults?.speciesKey || Object.keys(state.builtinSpecies)[0] || '';
  $('builtinSpeciesSelect').value = speciesKey; $('customSpeciesInput').value = zone?.speciesProfile?.type === 'custom' ? zone.speciesProfile.label || '' : '';
  const thresholds = zone?.speciesProfile?.thresholds || state.builtinSpecies[speciesKey]?.thresholds || {};
  $('phMinInput').value = thresholds.phMin ?? ''; $('phMaxInput').value = thresholds.phMax ?? ''; $('tempMinInput').value = thresholds.tempMin ?? ''; $('tempMaxInput').value = thresholds.tempMax ?? ''; $('turbidityMaxInput').value = thresholds.turbidityMax ?? '';
  const geometry = zone?.geometry || (defaults ? { center: defaults.center, lengthM: defaults.lengthM, widthM: defaults.widthM } : null);
  $('zoneLatInput').value = geometry?.center?.latitude ?? ''; $('zoneLonInput').value = geometry?.center?.longitude ?? ''; $('zoneLengthInput').value = geometry?.lengthM ?? ''; $('zoneWidthInput').value = geometry?.widthM ?? '';
  updateSpeciesForm(false); syncRegionMapFromForm(false);
}

function renderBuiltinSpecies() {
  const previous = $('builtinSpeciesSelect').value;
  $('builtinSpeciesSelect').innerHTML = Object.entries(state.builtinSpecies).map(([key, value]) => `<option value="${esc(key)}">${esc(value.label)}</option>`).join('');
  if (state.builtinSpecies[previous]) $('builtinSpeciesSelect').value = previous;
}

function ensureCreateSpeciesDefaults() {
  if (!state.creatingZone) return;
  const previous = $('builtinSpeciesSelect').value; renderBuiltinSpecies();
  if (!state.builtinSpecies[previous]) $('builtinSpeciesSelect').value = Object.keys(state.builtinSpecies)[0] || '';
  if ($('speciesModeSelect').value === 'builtin' && !state.formDirty.region) updateSpeciesForm(true);
}

function updateSpeciesForm(fillThresholds = true) {
  const custom = $('speciesModeSelect').value === 'custom';
  $('builtinSpeciesLabel').style.display = custom ? 'none' : 'flex'; $('customSpeciesLabel').style.display = custom ? 'flex' : 'none'; $('customSpeciesInput').required = custom; $('builtinSpeciesSelect').required = !custom;
  for (const id of ['phMinInput', 'phMaxInput', 'tempMinInput', 'tempMaxInput', 'turbidityMaxInput']) $(id).disabled = !custom;
  if (!custom && fillThresholds) {
    const thresholds = state.builtinSpecies[$('builtinSpeciesSelect').value]?.thresholds;
    if (thresholds) { $('phMinInput').value = thresholds.phMin ?? ''; $('phMaxInput').value = thresholds.phMax ?? ''; $('tempMinInput').value = thresholds.tempMin ?? ''; $('tempMaxInput').value = thresholds.tempMax ?? ''; $('turbidityMaxInput').value = thresholds.turbidityMax ?? ''; }
  }
}

function validateRegionForm() {
  for (const id of ['zoneNameInput','builtinSpeciesSelect','customSpeciesInput','zoneLatInput','zoneLonInput','zoneLengthInput','zoneWidthInput','phMinInput','phMaxInput','tempMinInput','tempMaxInput','turbidityMaxInput']) $(id).setCustomValidity('');
  const geometry = regionGeometryFromInputs(), custom = $('speciesModeSelect').value === 'custom';
  if (!$('zoneNameInput').value.trim()) $('zoneNameInput').setCustomValidity('请输入区域名称');
  if (!custom && !$('builtinSpeciesSelect').value) $('builtinSpeciesSelect').setCustomValidity('请选择内置养殖对象');
  if (custom && !$('customSpeciesInput').value.trim()) $('customSpeciesInput').setCustomValidity('请输入自定义养殖对象名称');
  if (!geometry) {
    const latitude = Number($('zoneLatInput').value), longitude = Number($('zoneLonInput').value), lengthM = Number($('zoneLengthInput').value), widthM = Number($('zoneWidthInput').value);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) $('zoneLatInput').setCustomValidity('纬度必须在 -90 到 90 之间');
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) $('zoneLonInput').setCustomValidity('经度必须在 -180 到 180 之间');
    if (!Number.isFinite(lengthM) || lengthM <= 0) $('zoneLengthInput').setCustomValidity('南北长度必须大于 0');
    if (!Number.isFinite(widthM) || widthM <= 0) $('zoneWidthInput').setCustomValidity('东西宽度必须大于 0');
  }
  if (custom) {
    const phMin = Number($('phMinInput').value), phMax = Number($('phMaxInput').value), tempMin = Number($('tempMinInput').value), tempMax = Number($('tempMaxInput').value), turbidityMax = Number($('turbidityMaxInput').value);
    if (!(phMin < phMax)) $('phMaxInput').setCustomValidity('pH 上限必须大于下限');
    if (!(tempMin < tempMax)) $('tempMaxInput').setCustomValidity('水温上限必须大于下限');
    if (!Number.isFinite(turbidityMax) || turbidityMax < 0) $('turbidityMaxInput').setCustomValidity('浊度上限不能小于 0');
  }
  return $('regionForm').reportValidity() && Boolean(geometry);
}

async function saveRegion() {
  if ($('saveRegionBtn').disabled || !validateRegionForm()) return;
  const body = { name: $('zoneNameInput').value.trim(), speciesMode: $('speciesModeSelect').value, speciesKey: $('builtinSpeciesSelect').value, customSpeciesName: $('customSpeciesInput').value.trim(), thresholds: { phMin: +$('phMinInput').value, phMax: +$('phMaxInput').value, tempMin: +$('tempMinInput').value, tempMax: +$('tempMaxInput').value, turbidityMax: +$('turbidityMaxInput').value }, center: { latitude: +$('zoneLatInput').value, longitude: +$('zoneLonInput').value }, lengthM: +$('zoneLengthInput').value, widthM: +$('zoneWidthInput').value };
  const id = $('regionIdInput').value, saveButton = $('saveRegionBtn'), label = saveButton.querySelector('span'); saveButton.disabled = true; label.textContent = '保存中…'; $('regionForm').setAttribute('aria-busy', 'true');
  try {
    const response = await api(id ? `/api/zones/${encodeURIComponent(id)}` : '/api/zones', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    state.zones = response.zones || state.zones; state.creatingZone = false; state.selectedZoneId = response.zone?.id || id; beginEditRegion(state.selectedZoneId, true); toast(id ? '区域修改已保存' : '区域已创建');
  } finally { saveButton.disabled = false; label.textContent = '保存'; $('regionForm').removeAttribute('aria-busy'); }
}

async function deleteRegion() {
  const zone = selectedZone(); if (!zone) return;
  if (!await openConfirm({ title: '删除养殖区域', eyebrow: 'AREA MANAGEMENT', message: `确定删除“${zone.name}”吗？历史采样会保留，区域可恢复。`, confirm: '删除区域', danger: true })) return;
  const response = await api(`/api/zones/${encodeURIComponent(zone.id)}`, { method: 'DELETE' }); state.zones = response.zones || state.zones; state.selectedZoneId = null; state.creatingZone = false; ensureSelection(); fillRegionForm(selectedZone()); state.regionMap.resetForm = captureRegionForm(); render(); syncRegionMapFromForm(true); toast('区域已移入回收区', 'warning');
}

async function recoverRegion() { const id = $('deletedZoneSelect').value; if (!id) return; const response = await api(`/api/zones/${encodeURIComponent(id)}/recover`, { method: 'POST' }); state.zones = response.zones || state.zones; beginEditRegion(id, true); toast('区域已恢复'); }

function renderSamples() {
  const filter = $('sampleFilter').value;
  const samples = state.samples.filter(sample => !sample.deletedAt && (!filter || sample.zoneId === filter));
  $('sampleTableBody').innerHTML = samples.length ? samples.map(sample => {
    const zone = getZone(sample.zoneId), risk = riskLevel(sample, zone), phTrust = edgeTrustSample(sample, 'ph'), tempTrust = edgeTrustSample(sample, 'temperature');
    return `<tr><td><input type="checkbox" data-sample-id="${esc(sample.id)}" ${state.selectedSampleIds.has(sample.id) ? 'checked' : ''} aria-label="选择 ${esc(formatDate(sample.savedAt || sample.receivedAt))} 样本"></td><td>${esc(formatDate(sample.savedAt || sample.receivedAt))}</td><td>${esc(zoneName(sample.zoneId))}</td><td><span class="source-tag ${sourceClass(sample.source)}">${esc(sourceText(sample.source))}</span></td><td><span class="value-trust"><b>${esc(sample.water?.ph ?? '—')}</b><small>${esc(phTrust.text)}</small></span></td><td><span class="value-trust"><b>${esc(sample.water?.tempC ?? '—')}</b><small>${esc(tempTrust.text)}</small></span></td><td>${esc(sample.water?.turbidity ?? '—')}</td><td><span class="risk-badge ${risk.level}">${esc(risk.label)}</span></td></tr>`;
  }).join('') : '<tr><td colspan="8" class="empty-state">暂无匹配样本</td></tr>';
  const selectedVisible = samples.filter(sample => state.selectedSampleIds.has(sample.id)).length;
  $('selectedCount').textContent = `已选择 ${state.selectedSampleIds.size} 条`; $('deleteSamplesBtn').disabled = state.selectedSampleIds.size === 0; $('clearRegionSamplesBtn').disabled = !selectedZone();
  $('selectAllSamples').checked = samples.length > 0 && selectedVisible === samples.length; $('selectAllSamples').indeterminate = selectedVisible > 0 && selectedVisible < samples.length;
}

function trendSamples() {
  const zone = selectedZone(); if (!zone) return [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return state.samples.filter(sample => !sample.deletedAt && sample.zoneId === zone.id && parseTime(sample.savedAt || sample.receivedAt) >= cutoff).sort((a, b) => parseTime(a.savedAt || a.receivedAt) - parseTime(b.savedAt || b.receivedAt));
}

function renderTrend() {
  const zone = selectedZone(), samples = trendSamples(); $('trendTitle').textContent = `${zone?.name || '选中区域'} · 最近 24 小时持久化采样`;
  const chart = $('trendChart'); chart.textContent = '';
  $('trendTableBody').innerHTML = samples.length ? samples.map(sample => `<tr><td>${esc(formatDate(sample.savedAt || sample.receivedAt))}</td><td>${esc(sourceText(sample.source))}</td><td>${esc(sample.water?.ph ?? '—')}</td><td>${esc(sample.water?.tempC ?? '—')}</td><td>${esc(sample.water?.turbidity ?? '—')}</td></tr>`).join('') : '<tr><td colspan="5">最近 24 小时暂无样本</td></tr>';
  if (!samples.length) { const empty = document.createElement('div'); empty.className = 'chart-empty'; empty.textContent = zone ? '最近 24 小时暂无该区域的持久化样本' : '请先选择区域'; chart.appendChild(empty); return; }
  const width = 760, height = 245, left = 62, right = 16, laneHeight = 58, laneGap = 12, start = parseTime(samples[0].savedAt || samples[0].receivedAt), end = Math.max(start + 1, parseTime(samples[samples.length - 1].savedAt || samples[samples.length - 1].receivedAt));
  const series = [{ key: 'ph', label: 'pH', color: '#477a55', get: s => s.water?.ph }, { key: 'temp', label: '水温 °C', color: '#a86625', get: s => s.water?.tempC }, { key: 'turb', label: '浊度 NTU', color: '#4f898c', get: s => s.water?.turbidity }];
  const x = time => samples.length === 1 ? (left + width - right) / 2 : left + (time - start) / (end - start) * (width - left - right);
  let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">`;
  series.forEach((item, lane) => {
    const values = samples.map(sample => Number(item.get(sample))).filter(Number.isFinite), min = Math.min(...values), max = Math.max(...values), top = 10 + lane * (laneHeight + laneGap), bottom = top + laneHeight;
    const y = value => bottom - 7 - (value - min) / (max - min || 1) * (laneHeight - 18);
    svg += `<text x="4" y="${top + 13}">${item.label}</text><text x="4" y="${bottom - 2}">${Number.isFinite(min) ? min.toFixed(1) : '—'}–${Number.isFinite(max) ? max.toFixed(1) : '—'}</text><line class="grid" x1="${left}" y1="${bottom}" x2="${width - right}" y2="${bottom}"></line>`;
    const points = samples.map(sample => ({ sample, value: Number(item.get(sample)), time: parseTime(sample.savedAt || sample.receivedAt) })).filter(point => Number.isFinite(point.value));
    if (points.length > 1) svg += `<polyline class="line" stroke="${item.color}" points="${points.map(point => `${x(point.time)},${y(point.value)}`).join(' ')}"></polyline>`;
    for (const point of points) svg += `<circle class="dot" fill="${item.color}" cx="${x(point.time)}" cy="${y(point.value)}" r="4"><title>${item.label}: ${point.value} · ${formatDate(point.sample.savedAt || point.sample.receivedAt)}</title></circle>`;
  });
  const ticks = samples.length === 1 ? [samples[0]] : [samples[0], samples[Math.floor((samples.length - 1) / 2)], samples[samples.length - 1]];
  svg += ticks.map(sample => `<text x="${x(parseTime(sample.savedAt || sample.receivedAt))}" y="240" text-anchor="middle">${new Date(sample.savedAt || sample.receivedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</text>`).join('') + '</svg>';
  chart.innerHTML = svg;
}

function renderAnalysis() {
  const zone = selectedZone(), analysis = zone ? state.riskAnalyses[zone.id] : null;
  $('adviceTitle').textContent = zone ? `${zone.name} · 养殖建议` : '养殖建议';
  if (!analysis) { $('analysisSource').textContent = '尚未分析'; $('analysisMeta').textContent = zone ? '可运行结构化风险分析' : '请先选择区域'; $('analysisLevel').textContent = '—'; $('analysisSummary').textContent = '等待真实分析结果'; $('analysisBody').textContent = '不会显示固定模型、置信度或演示建议。'; }
  else { const source = ({ anthropic: 'Anthropic', llm: 'LLM', rule: '规则', rule_fallback: '规则兜底' })[analysis.source] || analysis.source || '未知来源'; const confidence = ({ high: '高', medium: '中', low: '低' })[analysis.confidence] || analysis.confidence || '未标记'; const reasons = Array.isArray(analysis.reasons) && analysis.reasons.length ? `原因：${analysis.reasons.join('；')}` : ''; const suggestions = Array.isArray(analysis.suggestions) && analysis.suggestions.length ? `建议：${analysis.suggestions.join('；')}` : ''; $('analysisSource').textContent = source; $('analysisMeta').textContent = `${analysis.model || '未返回模型'} · 可信度 ${confidence} · ${formatDate(analysis.analyzedAt)}`; $('analysisLevel').textContent = ({ normal: '正常', warning: '预警', danger: '危险', unknown: '未知' })[analysis.level] || analysis.level || '—'; $('analysisSummary').textContent = analysis.summary || '服务端未返回摘要'; $('analysisBody').textContent = [reasons, suggestions].filter(Boolean).join('\n') || '结构化分析已完成，服务端未返回附加原因或建议。'; }
  const provider = state.llmConfig?.provider === 'anthropic' ? `Anthropic 兼容 · ${state.llmConfig.anthropicModel || '后端配置'}` : state.llmConfig?.enabled ? `LLM · ${state.llmConfig.provider}` : '规则兜底'; $('chatProvider').textContent = provider;
  renderChat();
}

function renderChat() {
  const root = $('chatLog'); root.textContent = ''; const zone = selectedZone(), messages = zone ? state.aiChat.messagesByZone[zone.id] || [] : [];
  if (!zone || !messages.length) { const wrap = document.createElement('div'); wrap.className = 'message system'; const p = document.createElement('p'); p.textContent = zone ? `已选择 ${zone.name}。发送问题后，回复及来源由服务端返回。` : '选择区域后发送问题。'; wrap.appendChild(p); root.appendChild(wrap); }
  for (const message of messages) { const wrap = document.createElement('div'); wrap.className = `message ${message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'bot'}`; const p = document.createElement('p'); p.textContent = message.text; if (message.source || message.model) { const small = document.createElement('small'); small.textContent = [message.source, message.model].filter(Boolean).join(' · '); p.appendChild(small); } wrap.appendChild(p); root.appendChild(wrap); }
  if (state.aiChat.loading) { const wrap = document.createElement('div'); wrap.className = 'message system'; const p = document.createElement('p'); p.textContent = '正在等待服务端分析…'; wrap.appendChild(p); root.appendChild(wrap); }
  root.scrollTop = root.scrollHeight;
}

function compactValue(key, data) {
  if (!data) return '—';
  if (key === 'ph') return scaled(data.ph, 100);
  if (key === 'tc') return Number(data.tv) === 1 ? scaled(data.tc, 100) : '无效';
  if (key === 'lat' || key === 'lon') return formatCoord(rawCoord(data[key]));
  if (['ir', 'ip', 'iy', 'nd', 'nt', 'bd', 'rd', 'xt', 'ch', 'aiph', 'ait', 'mls', 'mrs'].includes(key)) return scaled(data[key], 100);
  return dash(data[key]);
}

function renderDiagnostics() {
  const data = state.latestData, boot = state.latestBoot;
  $('diagGps').textContent = data ? `${dash(data.gb)} / ${dash(data.gl)}` : '—'; $('diagImu').textContent = data ? `${dash(data.ib)} / ${dash(data.ia)}` : '—'; $('diagSeq').textContent = data ? `${dash(data.seq)} / ${formatUptime(data.ms)}` : '—'; $('diagPartial').textContent = dash(state.status.partialBytes);
  const keys = ['ph','tc','tv','tb','fix','sat','lat','lon','iv','ir','ip','iy','ns','nd','nt','bs','bd','rs','rd','xt','ch','aiph','aiphn','ait','aitn','phr','phmv','tbr','tbmv','td','tbv','gb','gl','ib','ia','seq','ms','mls','mrs','mlo','mro'];
  $('compactFields').innerHTML = keys.map(key => `<div class="compact-field"><span>${key}</span><strong>${esc(compactValue(key, data))}</strong></div>`).join('') + `<div class="compact-field"><span>boot.v</span><strong>${esc(dash(boot?.v))}</strong></div><div class="compact-field"><span>boot.div</span><strong>${esc(dash(boot?.div ?? (boot?.phdiv != null && boot?.tbdiv != null ? `ph ${scaled(boot.phdiv,100)} / tb ${scaled(boot.tbdiv,100)}` : null)))}</strong></div>`;
  $('rawJson').textContent = data ? JSON.stringify(data, null, 2) : '暂无遥测';
  $('terminalLog').textContent = state.logs.length ? state.logs.slice().reverse().map(log => `[${formatDate(log.timestamp)}] [${dash(log.direction)}] ${dash(log.text)}`).join('\n') : '暂无日志';
  $('settingPhRaw').textContent = data ? `${dash(data.phr)} / ${dash(data.phmv)} mV` : '—'; $('settingTurbRaw').textContent = data ? `${dash(data.tbr)} / ${dash(data.tbmv)} mV / ${data.td == null ? '—' : Number(data.td) ? 'HIGH' : 'LOW'}` : '—'; $('settingTempValid').textContent = data ? Number(data.tv) === 1 ? '有效' : '无效' : '—'; $('settingMotorCal').textContent = data ? `LS ${scaled(data.mls,100)} / RS ${scaled(data.mrs,100)} / LO ${dash(data.mlo)} / RO ${dash(data.mro)}` : '—';
}

function renderConnection() {
  $('connectedPort').textContent = state.status.connected ? `${state.status.portPath || '—'} · ${state.status.baudRate || '—'}` : '未连接'; setRiskBadge($('serialBadge'), { level: state.status.connected ? 'normal' : 'unknown', label: state.status.connected ? '已连接' : '未连接' });
  $('connectBtn').disabled = state.status.connected || (!$('serialSelect').value && !($('serialManual') && $('serialManual').value.trim())); $('disconnectBtn').disabled = !state.status.connected; $('sidebarDevice').textContent = state.status.portPath || '等待设备'; $('sidebarDeviceState').textContent = state.status.connected ? '串口已连接' : '串口未连接'; $('sidebarDot').className = `status-dot ${state.status.connected ? 'online' : ''}`;
  const controls = qsa('[data-command], #sendCommandBtn, #sendMotorBtn, #stopMotorsBtn, #sendCalibrationBtn'); controls.forEach(control => { control.disabled = !state.status.connected; });
  $('manualSampleBtn').disabled = !state.status.connected || !state.latestData;
}

function ensureGpsTestMap() {
  if (state.gpsTestMap.instance || typeof L === 'undefined' || !$('gpsTestMap')) return;
  const map = L.map('gpsTestMap', { zoomControl: true, attributionControl: false, keyboard: true }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
  const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
  tileLayer.addTo(map);
  tileLayer.on('tileerror', () => $('gpsTestMap').classList.add('no-tiles'));
  tileLayer.on('load', () => $('gpsTestMap').classList.remove('no-tiles'));
  state.gpsTestMap.instance = map; state.gpsTestMap.tileLayer = tileLayer;
}

function gpsTestHasCoordinates() {
  const latest = state.gpsTest.latest;
  return Boolean(latest && Number.isFinite(Number(latest.latitude)) && Number.isFinite(Number(latest.longitude)) && !(Number(latest.latitude) === 0 && Number(latest.longitude) === 0));
}

function gpsTestHasFix() {
  const latest = state.gpsTest.latest;
  return gpsTestHasCoordinates() && (Number(latest.fix) > 0 || latest.valid === true);
}

function renderGpsTestMap() {
  ensureGpsTestMap();
  const map = state.gpsTestMap.instance; if (!map || typeof L === 'undefined') return;
  const points = Array.isArray(state.gpsTest.track) ? state.gpsTest.track.filter(point => Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude))).map(point => [Number(point.latitude), Number(point.longitude)]) : [];
  if (points.length) {
    if (!state.gpsTestMap.trackLine) state.gpsTestMap.trackLine = L.polyline(points, { color: '#477a55', weight: 3, opacity: .78, lineCap: 'round', lineJoin: 'round' }).addTo(map); else state.gpsTestMap.trackLine.setLatLngs(points);
  } else if (state.gpsTestMap.trackLine) { map.removeLayer(state.gpsTestMap.trackLine); state.gpsTestMap.trackLine = null; }
  const latest = state.gpsTest.latest;
  if (gpsTestHasCoordinates()) {
    const fixed = gpsTestHasFix(), latLng = [Number(latest.latitude), Number(latest.longitude)];
    const markerStyle = { radius: 9, color: '#fff', weight: 3, fillColor: fixed ? '#4f898c' : '#a86625', fillOpacity: 1 };
    if (!state.gpsTestMap.marker) state.gpsTestMap.marker = L.circleMarker(latLng, markerStyle).addTo(map).bindTooltip(fixed ? 'GPS 当前位置' : 'GPS 坐标（等待定位确认）');
    else { state.gpsTestMap.marker.setLatLng(latLng).setStyle(markerStyle); state.gpsTestMap.marker.setTooltipContent(fixed ? 'GPS 当前位置' : 'GPS 坐标（等待定位确认）'); }
    if (!state.gpsTestMap.autoCentered) { map.setView(latLng, BOAT_FOCUS_ZOOM); state.gpsTestMap.autoCentered = true; }
    $('gpsTestCoordinate').textContent = `坐标 ${Number(latest.latitude).toFixed(7)}, ${Number(latest.longitude).toFixed(7)}`;
    $('gpsTestMapTip').textContent = fixed ? `定位已更新 · ${points.length} 个轨迹点` : '已收到坐标 · 等待定位状态确认';
  } else {
    if (state.gpsTestMap.marker) { map.removeLayer(state.gpsTestMap.marker); state.gpsTestMap.marker = null; }
    state.gpsTestMap.autoCentered = false; $('gpsTestCoordinate').textContent = '坐标 —'; $('gpsTestMapTip').textContent = state.gpsTest.connected || state.gpsTest.lastSentenceAt ? '正在等待经纬度数据' : '等待 GPS 串口连接';
  }
}

function renderGpsTest() {
  const gps = state.gpsTest || {}, latest = gps.latest || {}, fixed = gpsTestHasFix();
  setRiskBadge($('gpsTestBadge'), { level: gps.connected ? 'normal' : 'unknown', label: gps.connected ? '已连接' : '未连接' });
  $('gpsTestConnectedPort').textContent = gps.connected ? `${gps.portPath || '—'} · ${gps.baudRate || '—'}` : '未连接';
  $('gpsTestLastSentence').textContent = `最后语句：${gps.lastSentenceAt ? formatDate(gps.lastSentenceAt) : '—'}`;
  $('gpsTestConnectBtn').disabled = Boolean(gps.connected) || !$('gpsTestPortSelect').value;
  $('gpsTestDisconnectBtn').disabled = !gps.connected;
  $('gpsTestCenterBtn').disabled = !gpsTestHasCoordinates();
  $('gpsTestFixIndicator').className = `gps-fix-indicator ${fixed ? 'fixed' : gps.connected ? 'searching' : ''}`;
  $('gpsTestFixIndicator').lastChild.textContent = fixed ? '定位有效' : gps.connected ? '搜星中' : '等待';
  const fixLabels = { 0: '未定位', 1: 'GPS / SPS', 2: '差分定位', 3: 'PPS', 4: 'RTK 固定', 5: 'RTK 浮点', 6: '估算' };
  $('gpsTestFix').textContent = latest.fix == null ? '—' : fixLabels[Number(latest.fix)] || `类型 ${latest.fix}`;
  $('gpsTestSatellites').textContent = dash(latest.satellites);
  $('gpsTestLatitude').textContent = latest.latitude == null ? '—' : Number(latest.latitude).toFixed(7);
  $('gpsTestLongitude').textContent = latest.longitude == null ? '—' : Number(latest.longitude).toFixed(7);
  $('gpsTestAltitude').textContent = latest.altitudeM == null || !Number.isFinite(Number(latest.altitudeM)) ? '—' : `${Number(latest.altitudeM).toFixed(1)} m`;
  $('gpsTestHdop').textContent = latest.hdop == null || !Number.isFinite(Number(latest.hdop)) ? '—' : Number(latest.hdop).toFixed(1);
  $('gpsTestSpeed').textContent = latest.speedKph == null || !Number.isFinite(Number(latest.speedKph)) ? '—' : `${Number(latest.speedKph).toFixed(2)} km/h`;
  $('gpsTestCourse').textContent = latest.course == null || !Number.isFinite(Number(latest.course)) ? '—' : `${Number(latest.course).toFixed(1)}°`;
  $('gpsTestUtc').textContent = dash(latest.utc);
  $('gpsTestSentenceType').textContent = latest.sentenceType ? `${dash(latest.talker)}${latest.sentenceType}` : '—';
  $('gpsTestBytes').textContent = dash(gps.byteCount || 0); $('gpsTestSentences').textContent = dash(gps.sentenceCount || 0); $('gpsTestChecksumErrors').textContent = dash(gps.checksumErrors || 0); $('gpsTestTrackPoints').textContent = dash(gps.track?.length || 0);
  $('gpsTestChecksum').textContent = latest.checksumValid === true ? 'CHECK OK' : latest.checksumValid === false ? 'CHECK ERR' : 'CHECK —';
  $('gpsTestChecksum').style.color = latest.checksumValid === false ? 'var(--danger)' : latest.checksumValid === true ? 'var(--primary)' : '';
  $('gpsTestTerminal').textContent = Array.isArray(gps.lines) && gps.lines.length ? gps.lines.slice().reverse().map(line => `[${formatDate(line.receivedAt)}] [${line.type || 'NMEA'}]${line.checksumValid === false ? ' [CHECKSUM ERROR]' : ''} ${line.text}`).join('\n') : '暂无 NMEA 数据';
  $('gpsTestTerminal').scrollTop = $('gpsTestTerminal').scrollHeight;
  renderGpsTestMap();
}

function renderSettings() {
  /* 把固件里实际生效的电机校准同步到输入框。
   * 不同步的话输入框一直是空的，用户点一次"发送校准参数"就会
   * 把实测标定值（ls=0.90 / 死区 300）覆盖成默认值。 */
  const live = state.latestData;
  if (live) {
    const syncCal = (id, value) => {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = value;
    };
    if (live.mls !== undefined) syncCal('calLeftScale', (live.mls / 100).toFixed(2));
    if (live.mrs !== undefined) syncCal('calRightScale', (live.mrs / 100).toFixed(2));
    if (live.mlo !== undefined) syncCal('calLeftOffset', live.mlo);
    if (live.mro !== undefined) syncCal('calRightOffset', live.mro);
  }

  const config = state.sampling.config || {};
  const pairs = [['arrivalRadiusInput', config.arrivalRadiusM], ['fallbackRadiusInput', config.fallbackRadiusM], ['boundaryMarginInput', config.boundaryMarginM], ['returnRadiusInput', config.returnRadiusM], ['fallbackAfterInput', config.fallbackAfterMs == null ? '' : config.fallbackAfterMs / 1000], ['targetTimeoutInput', config.targetTimeoutMs == null ? '' : config.targetTimeoutMs / 60000], ['stabilizationInput', config.stabilizationMs == null ? '' : config.stabilizationMs / 1000], ['sampleIntervalInput', config.sampleIntervalMs == null ? '' : config.sampleIntervalMs / 1000], ['sampleDurationInput', config.sampleDurationMs == null ? '' : config.sampleDurationMs / 60000]];
  if (!state.formDirty.sampling) for (const [id, value] of pairs) $(id).value = value ?? '';
  if (!state.formDirty.llm) {
    $('llmProviderSelect').value = state.llmConfig.provider || 'disabled';
    $('llmCloudEndpoint').value = state.llmConfig.cloudEndpoint || '';
    $('llmCloudModel').value = state.llmConfig.cloudModel || '';
    $('llmOllamaEndpoint').value = state.llmConfig.ollamaEndpoint || '';
    $('llmOllamaModel').value = state.llmConfig.ollamaModel || '';
  }
}

function render() {
  renderFreshness(); renderKpis(); renderTelemetry(); renderMap(); renderTargetControls(); renderRegionSummary(); renderMission(); renderZoneLists(); renderSamples(); renderTrend(); renderAnalysis(); renderDiagnostics(); renderConnection(); renderGpsTest(); renderSettings(); renderRegionMapContext(); syncRegionMapFromForm(false); iconRefresh();
}

async function refreshStatus() { const payload = await api('/api/status'); applyStatus(payload); render(); }
async function refreshPorts() {
  const previous = $('serialSelect').value, gpsPrevious = $('gpsTestPortSelect').value; const response = await api('/api/ports'); const ports = response.ports || [];
  const options = ports.length ? ports.map(port => { const detail = [port.friendlyName, port.manufacturer].filter(Boolean).join(' / '); return `<option value="${esc(port.path)}">${esc(detail ? `${port.path} · ${detail}` : port.path)}</option>`; }).join('') : '<option value="">未发现串口</option>';
  $('serialSelect').innerHTML = options; $('gpsTestPortSelect').innerHTML = options;
  if (ports.some(port => port.path === previous)) $('serialSelect').value = previous;
  if (ports.some(port => port.path === gpsPrevious)) $('gpsTestPortSelect').value = gpsPrevious;
  renderConnection(); renderGpsTest();
}

async function connectSerial() {
  /* 网络串口优先：填了 tcp://... 就连远端中继，否则用本地 COM 口 */
  const manual = ($('serialManual').value || '').trim();
  const path = manual || $('serialSelect').value;
  if (!path) return toast('请先选择串口，或填写网络串口地址', 'warning');
  if (manual) localStorage.setItem('boatSerialManual', manual);
  await api('/api/serial/open', { method: 'POST', body: JSON.stringify({ path, baudRate: Number($('baudSelect').value) || 115200 }) });
  await refreshStatus();
  toast(manual ? `已连接远端中继 ${manual}` : '串口连接请求成功');
}
async function disconnectSerial() { await api('/api/serial/close', { method: 'POST' }); await refreshStatus(); toast('串口已断开', 'warning'); }
async function connectGpsTest() { const path = $('gpsTestPortSelect').value; if (!path) return toast('请先选择 GPS 串口', 'warning'); const response = await api('/api/gps-test/open', { method: 'POST', body: JSON.stringify({ path, baudRate: Number($('gpsTestBaudSelect').value) || 38400 }) }); state.gpsTest = response.gpsTest || state.gpsTest; renderGpsTest(); toast('GPS 测试串口已连接'); }
async function disconnectGpsTest() { const response = await api('/api/gps-test/close', { method: 'POST' }); state.gpsTest = response.gpsTest || state.gpsTest; state.gpsTestMap.autoCentered = false; renderGpsTest(); toast('GPS 测试串口已断开', 'warning'); }
async function clearGpsTest() { const response = await api('/api/gps-test/clear', { method: 'POST' }); state.gpsTest = response.gpsTest || state.gpsTest; state.gpsTestMap.autoCentered = false; renderGpsTest(); toast('GPS 测试数据已清空'); }
async function serialSendObject(object) { if (!state.status.connected) throw new Error('串口未连接'); await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ message: JSON.stringify(object), appendNewline: true, broadcast: false }) }); toast('指令已发送；未确认船体物理执行'); }
async function sendCommand(command) { await serialSendObject({ t: 'cmd', cmd: command }); }
async function sendMotor(left, right) { await serialSendObject({ t: 'motor', l: Math.round(clamp(left, -100, 100)), r: Math.round(clamp(right, -100, 100)) }); }
/**
 * 下发电机校准。
 *
 * 原来的实现直接 clamp 输入框的值，而输入框初始为空 ——
 * Number('') || 0 得到 0，一次误点就会把左右缩放都写成 0（电机彻底不动）。
 * 现在：空值/非法值回落到当前遥测里的实际值，不会把已标定的参数抹掉。
 */
async function sendCalibration() {
  const live = state.latestData || {};
  const readNum = (id, fallback, min, max) => {
    const raw = $(id).value;
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const body = {
    t: 'mcal',
    ls: +readNum('calLeftScale', (live.mls ?? 100) / 100, 0, 2).toFixed(2),
    rs: +readNum('calRightScale', (live.mrs ?? 100) / 100, 0, 2).toFixed(2),
    lo: Math.round(readNum('calLeftOffset', live.mlo ?? 0, -200, 200)),
    ro: Math.round(readNum('calRightOffset', live.mro ?? 0, -200, 200))
  };

  await serialSendObject(body);
}
function isFlatObject(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item === null || ['string','number','boolean'].includes(typeof item)); }

async function startZoneInspection() {
  const zone = selectedZone();
  if (!zone) return toast('请先选择区域', 'warning');
  if (!state.status.connected) return toast('串口未连接', 'warning');
  if (!await openConfirm({ title: '发起区域巡检', eyebrow: 'MISSION CONTROL', message: `确认按当前任务参数巡检“${zone.name}”吗？目标将立即通过 LoRa 下发。`, confirm: '下发巡检目标' })) return;
  try {
    const response = await api('/api/targets/zone', { method: 'POST', body: JSON.stringify({ zoneId: zone.id }) });
    state.sampling = response.sampling || state.sampling;
    const target = state.sampling.task?.target;
    if (target) state.selectedTarget = { latitude: target.latitude, longitude: target.longitude };
    render();
    toast('巡检目标已发送；等待任务状态更新');
  } catch (error) {
    try { await refreshStatus(); } catch {}
    throw error;
  }
}
async function cancelSampling() {
  if (!activeTask()) return;
  if (!await openConfirm({ title: '取消巡检任务', eyebrow: 'MISSION CONTROL', message: '将取消服务端任务并尝试通过 LoRa 发送停船指令。', confirm: '确认取消', danger: true })) return;
  const response = await api('/api/sampling/cancel', { method: 'POST' });
  state.sampling = response.sampling || state.sampling;
  render();
  toast(response.stopCommandSent ? '任务已取消，停船指令已发送（未确认 ACK）' : `任务已取消，但停船指令未发送：${response.stopCommandError || '未知错误'}`, response.stopCommandSent ? 'warning' : 'error');
}
async function emergencyStop() {
  if (activeTask()) {
    const response = await api('/api/sampling/cancel', { method: 'POST' });
    state.sampling = response.sampling || state.sampling;
    render();
    toast(response.stopCommandSent ? '任务已取消，停船指令已发送（未确认 ACK）' : `服务端任务已取消，但停船指令未发送：${response.stopCommandError || '未知错误'}`, response.stopCommandSent ? 'warning' : 'error');
    return;
  }
  await sendCommand('stop');
}
async function retryTarget() { try { const response = await api('/api/sampling/retry-target', { method: 'POST' }); state.sampling = response.sampling || state.sampling; render(); toast('目标重试请求已发送'); } catch (error) { if (error.status === 404) toast('当前服务端未提供目标重试接口，请取消后重新发起巡检', 'warning'); else throw error; } }
/**
 * 下发手动地图选点。
 * 走 /api/targets/point：服务端会等船端 target ack，没等到就重发，
 * 只有确认船收到了才返回成功。原来的实现只写串口、不等确认，
 * 在这条半双工链路上会静默失败。
 */
async function sendMapTarget() {
  const target = state.selectedTarget;
  if (!target) return;
  if (activeTask()) return toast('当前存在区域巡检任务，请先取消后再发送临时地图目标', 'warning');

  const button = $('sendMapTargetBtn');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '下发确认中…';

  try {
    const response = await api('/api/targets/point', {
      method: 'POST',
      body: JSON.stringify({ latitude: target.latitude, longitude: target.longitude })
    });
    toast(`目标已送达船端 (${target.latitude.toFixed(6)}, ${target.longitude.toFixed(6)})`);
    return response;
  } finally {
    button.textContent = original;
    renderTargetControls();
  }
}
async function saveSamplingConfig() { const body = { arrivalRadiusM: +$('arrivalRadiusInput').value, fallbackRadiusM: +$('fallbackRadiusInput').value, boundaryMarginM: +$('boundaryMarginInput').value, returnRadiusM: +$('returnRadiusInput').value, fallbackAfterMs: +$('fallbackAfterInput').value * 1000, targetTimeoutMs: +$('targetTimeoutInput').value * 60000, stabilizationMs: +$('stabilizationInput').value * 1000, sampleIntervalMs: +$('sampleIntervalInput').value * 1000, sampleDurationMs: +$('sampleDurationInput').value * 60000 }; const response = await api('/api/sampling/config', { method: 'PUT', body: JSON.stringify(body) }); state.sampling = response.sampling || state.sampling; state.formDirty.sampling = false; render(); toast('任务参数已保存'); }
async function manualSample() { const zone = selectedZone(); if (!zone) return toast('请先选择区域', 'warning'); const response = await api('/api/sampling/manual-sample', { method: 'POST', body: JSON.stringify({ zoneId: zone.id }) }); state.samples = response.samples || state.samples; state.latestSampleByZone = response.latestSampleByZone || state.latestSampleByZone; render(); toast('当前遥测已保存为手动样本'); }
async function testSample() { const zone = selectedZone(); if (!zone) return toast('请先选择区域', 'warning'); const response = await api('/api/sampling/test-sample', { method: 'POST', body: JSON.stringify({ zoneId: zone.id, ph: +$('testPhInput').value, tempC: +$('testTempInput').value, turbidity: +$('testTurbidityInput').value }) }); state.samples = response.samples || state.samples; state.latestSampleByZone = response.latestSampleByZone || state.latestSampleByZone; render(); toast('测试样本已写入'); }
async function deleteSelectedSamples() { const ids = Array.from(state.selectedSampleIds); if (!ids.length) return; if (!await openConfirm({ title: '删除采样记录', eyebrow: 'SAMPLE HISTORY', message: `确定删除选中的 ${ids.length} 条样本吗？`, confirm: '删除样本', danger: true })) return; const response = await api('/api/samples/delete', { method: 'POST', body: JSON.stringify({ ids }) }); state.samples = response.samples || state.samples; state.latestSampleByZone = response.latestSampleByZone || state.latestSampleByZone; state.selectedSampleIds.clear(); render(); toast('样本已删除', 'warning'); }
async function clearZoneSamples() { const zone = selectedZone(); if (!zone) return; if (!await openConfirm({ title: '清空区域样本', eyebrow: 'SAMPLE HISTORY', message: `确定清空“${zone.name}”的可见样本吗？`, confirm: '确认清空', danger: true })) return; const response = await api(`/api/zones/${encodeURIComponent(zone.id)}/samples/delete`, { method: 'POST' }); state.samples = response.samples || state.samples; state.latestSampleByZone = response.latestSampleByZone || state.latestSampleByZone; render(); toast('区域样本已清空', 'warning'); }
async function analyzeZone() { const zone = selectedZone(); if (!zone) return toast('请先选择区域', 'warning'); const response = await api('/api/analysis/risk', { method: 'POST', body: JSON.stringify({ zoneId: zone.id }) }); state.riskAnalyses[zone.id] = response.analysis; renderAnalysis(); renderRegionSummary(); toast('结构化风险分析已更新'); }
async function analyzeAll() { const response = await api('/api/analysis/risk/batch', { method: 'POST', body: '{}' }); state.riskAnalyses = response.analyses || {}; render(); toast('批量风险分析已完成'); }
async function sendChat(question) { const zone = selectedZone(); if (!zone) return toast('请先选择区域', 'warning'); const text = String(question || $('chatQuestion').value).trim(); if (!text || state.aiChat.loading) return; const messages = state.aiChat.messagesByZone[zone.id] || []; state.aiChat.messagesByZone[zone.id] = messages; messages.push({ role: 'user', text }); $('chatQuestion').value = ''; state.aiChat.loading = true; renderChat(); try { const response = await api('/api/analysis/chat', { method: 'POST', body: JSON.stringify({ zoneId: zone.id, message: text }) }); messages.push({ role: 'assistant', text: response.reply || '服务端未返回内容', source: response.source, model: response.model }); } catch (error) { messages.push({ role: 'system', text: `分析暂不可用：${error.message}` }); } finally { state.aiChat.loading = false; renderChat(); } }
async function saveLlmConfig() { const body = { provider: $('llmProviderSelect').value, cloudEndpoint: $('llmCloudEndpoint').value, cloudModel: $('llmCloudModel').value, ollamaEndpoint: $('llmOllamaEndpoint').value, ollamaModel: $('llmOllamaModel').value }; const cloudApiKey = $('llmCloudApiKey').value.trim(); if (cloudApiKey) body.cloudApiKey = cloudApiKey; const response = await api('/api/analysis/config', { method: 'PUT', body: JSON.stringify(body) }); state.llmConfig = response.llmConfig || state.llmConfig; state.formDirty.llm = false; $('llmCloudApiKey').value = ''; renderSettings(); renderAnalysis(); toast('分析配置已保存'); }

function navigate(view) {
  if (['control','diagnostics','settings'].includes(view) && !document.body.classList.contains('advanced')) return toast('请先开启高级模式', 'warning');
  qsa('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view)); qsa('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
  const titles = { overview: ['实时作业中心','水质巡检总览'], regions: ['区域与阈值','养殖区域管理'], tasks: ['自动化任务','巡检任务中心'], samples: ['历史数据','采样记录管理'], advice: ['智能分析','养殖建议'], connection: ['系统与设备','连接管理'], 'gps-test': ['设备测试','GPS 串口测试'], control: ['高级调试','船体控制'], diagnostics: ['高级调试','通信诊断'], settings: ['系统配置','高级设置'] };
  $('pageEyebrow').textContent = titles[view][0]; $('pageTitle').textContent = titles[view][1]; $('sidebar').classList.remove('open'); window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'overview') setTimeout(() => state.map.instance?.invalidateSize(), 100);
  if (view === 'gps-test') setTimeout(() => { ensureGpsTestMap(); state.gpsTestMap.instance?.invalidateSize(); renderGpsTestMap(); }, 100);
  if (view === 'regions') setTimeout(() => { ensureRegionMap(); state.regionMap.instance?.invalidateSize(); renderRegionMapContext(); syncRegionMapFromForm(state.regionMap.focusPending); state.regionMap.focusPending = false; }, 100);
}

function connectSocket() {
  clearTimeout(state.wsTimer); const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; const socket = new WebSocket(`${protocol}//${location.host}/ws`); state.socket = socket;
  socket.addEventListener('open', async () => { state.wsConnected = true; state.wsRetries = 0; state.wsLastAt = Date.now(); renderFreshness(); try { await refreshStatus(); } catch (error) { toast(`状态同步失败：${error.message}`, 'warning'); } });
  socket.addEventListener('message', event => {
    state.wsLastAt = Date.now(); let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.kind === 'snapshot') applyStatus(message);
    else if (message.kind === 'serial-status') state.status = message.status || state.status;
    else if (message.kind === 'serial-message') { state.status = message.status || state.status; state.latestBoot = message.latestBoot || state.latestBoot; state.latestData = message.latestData || state.latestData; state.telemetryLastAt = parseTime(message.latestDataReceivedAt) || state.telemetryLastAt; if (message.entry) state.history = [message.entry, ...state.history].slice(0, 200); if (message.log) state.logs = [message.log, ...state.logs].slice(0, 400); pushTelemetryBuffers(); }
    else if (message.kind === 'serial-log') { state.status = message.status || state.status; if (message.log) state.logs = [message.log, ...state.logs].slice(0, 400); }
    else if (message.kind === 'gps-test-status') state.gpsTest = message.gpsTest || state.gpsTest;
    else if (message.kind === 'gps-test-message') { const lines = message.line ? [message.line, ...(state.gpsTest.lines || [])].slice(0, 200) : state.gpsTest.lines || []; const track = message.point ? [...(state.gpsTest.track || []), message.point].slice(-500) : state.gpsTest.track || []; state.gpsTest = { ...state.gpsTest, ...(message.gpsTest || {}), lines, track }; }
    else if (message.kind === 'gps-test-error') { state.gpsTest = message.gpsTest || state.gpsTest; toast(`GPS 串口错误：${message.message || '未知错误'}`, 'error'); }
    else if (message.kind === 'zones-updated') { state.zones = message.zones || state.zones; ensureSelection(); if (!state.creatingZone && !state.formDirty.region) fillRegionForm(selectedZone()); else if (state.creatingZone) ensureCreateSpeciesDefaults(); renderRegionMapContext(); }
    else if (message.kind === 'samples-updated') { state.samples = message.samples || state.samples; state.latestSampleByZone = message.latestSampleByZone || state.latestSampleByZone; }
    else if (message.kind === 'sample-created') { if (message.sample && !message.sample.deletedAt) state.samples = [message.sample, ...state.samples.filter(sample => sample.id !== message.sample.id)].slice(0, 500); state.latestSampleByZone = message.latestSampleByZone || state.latestSampleByZone; state.sampling = message.sampling || state.sampling; }
    else if (message.kind === 'sampling-update') state.sampling = message.sampling || state.sampling;
    else if (message.kind === 'serial-error') { state.status = message.status || state.status; toast(`串口错误：${message.message || '未知错误'}`, 'error'); }
    render();
  });
  socket.addEventListener('close', () => { state.wsConnected = false; state.socket = null; state.wsRetries += 1; renderFreshness(); const delay = Math.min(10000, 1000 * 2 ** Math.min(state.wsRetries - 1, WS_MAX_RETRIES)); state.wsTimer = setTimeout(async () => { try { await refreshStatus(); } catch {} connectSocket(); }, delay); });
  socket.addEventListener('error', () => socket.close());
}

function bindEvents() {
  qsa('.nav-item').forEach(item => item.addEventListener('click', () => navigate(item.dataset.view))); qsa('[data-view-jump]').forEach(item => item.addEventListener('click', () => navigate(item.dataset.viewJump)));
  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('advancedToggle').addEventListener('change', event => { document.body.classList.toggle('advanced', event.target.checked); localStorage.setItem('boatAdvanced', event.target.checked ? '1' : '0'); if (!event.target.checked && qsa('#view-control.active,#view-diagnostics.active,#view-settings.active').length) navigate('overview'); setTimeout(() => state.map.instance?.invalidateSize(), 100); });
  qsa('[data-action="center-boat"]').forEach(button => button.addEventListener('click', () => { const boat = boatCoords(); if (!boat) return toast('暂无有效 GPS 定位', 'warning'); state.map.instance?.setView([boat.latitude, boat.longitude], BOAT_FOCUS_ZOOM); }));
  qsa('[data-action="clear-target"]').forEach(button => button.addEventListener('click', () => { state.selectedTarget = null; renderMap(); renderTargetControls(); toast('地图目标已清除'); }));
  qsa('[data-action="new-inspection"], [data-action="inspect-region"]').forEach(button => button.addEventListener('click', () => startZoneInspection().catch(error => toast(error.message, 'error'))));
  qsa('[data-action="refresh-risk"]').forEach(button => button.addEventListener('click', () => analyzeZone().catch(error => toast(error.message, 'error'))));
  qsa('[data-action="batch-risk"]').forEach(button => button.addEventListener('click', () => analyzeAll().catch(error => toast(error.message, 'error'))));
  qsa('[data-action="create-region"]').forEach(button => button.addEventListener('click', beginCreateRegion));
  qsa('[data-map-layer]').forEach(button => button.addEventListener('click', () => { state.map.tileMode = button.dataset.mapLayer; qsa('[data-map-layer]').forEach(item => item.classList.toggle('active', item === button)); $('mapCanvas').classList.toggle('no-tiles', state.map.tileMode === 'fallback'); }));
  $('sendMapTargetBtn').addEventListener('click', () => sendMapTarget().catch(error => toast(error.message, 'error')));
  $('globalStopBtn').addEventListener('click', () => emergencyStop().catch(error => toast(error.message, 'error')));
  $('cancelTaskBtn').addEventListener('click', () => cancelSampling().catch(error => toast(error.message, 'error'))); $('taskCancelBtn').addEventListener('click', () => cancelSampling().catch(error => toast(error.message, 'error')));
  $('retryTargetBtn').addEventListener('click', () => retryTarget().catch(error => toast(error.message, 'error'))); $('taskRetryBtn').addEventListener('click', () => retryTarget().catch(error => toast(error.message, 'error')));
  $('saveSamplingConfigBtn').addEventListener('click', () => saveSamplingConfig().catch(error => toast(error.message, 'error')));
  $('regionSearch').addEventListener('input', renderZoneLists); $('regionList').addEventListener('click', event => { const button = event.target.closest('[data-zone-id]'); if (button) selectZone(button.dataset.zoneId); });
  $('regionForm').addEventListener('input', event => { state.formDirty.region = true; event.target.setCustomValidity?.(''); if (['zoneLatInput','zoneLonInput','zoneLengthInput','zoneWidthInput'].includes(event.target.id)) syncRegionMapFromForm(false); });
  $('regionForm').addEventListener('submit', event => { event.preventDefault(); saveRegion().catch(error => toast(error.message, 'error')); });
  $('samplingConfigForm').addEventListener('input', () => { state.formDirty.sampling = true; });
  $('llmConfigForm').addEventListener('input', () => { state.formDirty.llm = true; });
  $('speciesModeSelect').addEventListener('change', () => { state.formDirty.region = true; updateSpeciesForm(true); }); $('builtinSpeciesSelect').addEventListener('change', () => { state.formDirty.region = true; updateSpeciesForm(true); });
  $('drawRegionBtn').addEventListener('click', startRegionDrawing); $('fitRegionBtn').addEventListener('click', () => focusRegionGeometry()); $('locateRegionBoatBtn').addEventListener('click', () => { const boat = boatCoords(); if (!boat) return toast('暂无有效 GPS 定位', 'warning'); ensureRegionMap(); state.regionMap.instance?.setView([boat.latitude, boat.longitude], BOAT_FOCUS_ZOOM); }); $('resetRegionBtn').addEventListener('click', resetRegionEditor);
  $('deleteRegionBtn').addEventListener('click', () => deleteRegion().catch(error => toast(error.message, 'error'))); $('recoverZoneBtn').addEventListener('click', () => recoverRegion().catch(error => toast(error.message, 'error')));
  $('sampleFilter').addEventListener('change', () => { state.selectedSampleIds.clear(); renderSamples(); }); $('sampleTableBody').addEventListener('change', event => { const id = event.target.dataset.sampleId; if (!id) return; event.target.checked ? state.selectedSampleIds.add(id) : state.selectedSampleIds.delete(id); renderSamples(); }); $('selectAllSamples').addEventListener('change', event => { const filter = $('sampleFilter').value; state.samples.filter(sample => !sample.deletedAt && (!filter || sample.zoneId === filter)).forEach(sample => event.target.checked ? state.selectedSampleIds.add(sample.id) : state.selectedSampleIds.delete(sample.id)); renderSamples(); }); $('deleteSamplesBtn').addEventListener('click', () => deleteSelectedSamples().catch(error => toast(error.message, 'error'))); $('clearRegionSamplesBtn').addEventListener('click', () => clearZoneSamples().catch(error => toast(error.message, 'error'))); $('manualSampleBtn').addEventListener('click', () => manualSample().catch(error => toast(error.message, 'error'))); $('openTestSampleBtn').addEventListener('click', () => navigate('settings'));
  $('trendTableToggle').addEventListener('click', () => { const open = $('chartTable').classList.toggle('open'); $('trendTableToggle').setAttribute('aria-expanded', String(open)); $('trendTableToggle').textContent = open ? '隐藏数据表' : '查看数据表'; });
  $('riskAnalysisBtn').addEventListener('click', () => analyzeZone().catch(error => toast(error.message, 'error'))); $('analyzeAdviceBtn').addEventListener('click', () => analyzeZone().catch(error => toast(error.message, 'error'))); $('chatForm').addEventListener('submit', event => { event.preventDefault(); sendChat().catch(error => toast(error.message, 'error')); }); qsa('.quick-questions button').forEach(button => button.addEventListener('click', () => sendChat(button.textContent).catch(error => toast(error.message, 'error'))));
  $('refreshPortsBtn').addEventListener('click', () => refreshPorts().then(() => toast('串口列表已刷新')).catch(error => toast(error.message, 'error'))); $('serialSelect').addEventListener('change', renderConnection); $('connectBtn').addEventListener('click', () => connectSerial().catch(error => toast(error.message, 'error'))); $('disconnectBtn').addEventListener('click', () => disconnectSerial().catch(error => toast(error.message, 'error')));
  $('gpsTestRefreshBtn').addEventListener('click', () => refreshPorts().then(() => toast('GPS 串口列表已刷新')).catch(error => toast(error.message, 'error'))); $('gpsTestPortSelect').addEventListener('change', renderGpsTest); $('gpsTestConnectBtn').addEventListener('click', () => connectGpsTest().catch(error => toast(error.message, 'error'))); $('gpsTestDisconnectBtn').addEventListener('click', () => disconnectGpsTest().catch(error => toast(error.message, 'error'))); $('gpsTestClearBtn').addEventListener('click', () => clearGpsTest().catch(error => toast(error.message, 'error'))); $('gpsTestCenterBtn').addEventListener('click', () => { const latest = state.gpsTest.latest; if (!gpsTestHasCoordinates()) return toast('暂无 GPS 坐标', 'warning'); state.gpsTestMap.instance?.setView([Number(latest.latitude), Number(latest.longitude)], BOAT_FOCUS_ZOOM); });
  qsa('[data-command]').forEach(button => button.addEventListener('click', () => sendCommand(button.dataset.command).catch(error => toast(error.message, 'error'))));
  $('sendCommandBtn').addEventListener('click', () => { let value; try { value = JSON.parse($('customCommand').value); } catch { return toast('自定义指令不是有效 JSON', 'error'); } if (!isFlatObject(value)) return toast('自定义指令必须是扁平 JSON 对象', 'error'); serialSendObject(value).catch(error => toast(error.message, 'error')); });
  for (const id of ['leftMotor','rightMotor']) $(id).addEventListener('input', event => $(id === 'leftMotor' ? 'leftMotorValue' : 'rightMotorValue').textContent = String(Math.round(clamp(event.target.value, -100, 100))));
  const presets = { forward: [50,50], back: [-50,-50], left: [-30,30], right: [30,-30] }; qsa('[data-motor]').forEach(button => button.addEventListener('click', () => { const [left,right] = presets[button.dataset.motor]; $('leftMotor').value = left; $('rightMotor').value = right; $('leftMotorValue').textContent = left; $('rightMotorValue').textContent = right; }));
  $('sendMotorBtn').addEventListener('click', () => sendMotor($('leftMotor').value, $('rightMotor').value).catch(error => toast(error.message, 'error'))); $('stopMotorsBtn').addEventListener('click', () => { $('leftMotor').value = 0; $('rightMotor').value = 0; $('leftMotorValue').textContent = '0'; $('rightMotorValue').textContent = '0'; sendMotor(0,0).catch(error => toast(error.message, 'error')); }); $('sendCalibrationBtn').addEventListener('click', () => sendCalibration().catch(error => toast(error.message, 'error')));
  $('clearLogsBtn').addEventListener('click', () => { state.logs = []; renderDiagnostics(); toast('浏览器日志视图已清空'); }); $('copyJsonBtn').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('rawJson').textContent); toast('原始 JSON 已复制'); } catch { toast('浏览器拒绝剪贴板访问', 'error'); } });
  $('llmConfigForm').addEventListener('submit', event => { event.preventDefault(); saveLlmConfig().catch(error => toast(error.message, 'error')); }); $('testSampleForm').addEventListener('submit', event => { event.preventDefault(); testSample().catch(error => toast(error.message, 'error')); });
  $('modalConfirmBtn').addEventListener('click', () => closeModal(true)); $('modalCancelBtn').addEventListener('click', () => closeModal(false)); $('modalCloseBtn').addEventListener('click', () => closeModal(false)); $('modalBackdrop').addEventListener('click', event => { if (event.target === $('modalBackdrop')) closeModal(false); }); document.addEventListener('keydown', event => { if (event.key !== 'Escape') return; if (state.regionMap.drawing) { stopRegionDrawing(true); syncRegionMapFromForm(false); $('drawRegionBtn').focus(); } else closeModal(false); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.wsConnected && state.wsRetries >= WS_MAX_RETRIES) { state.wsRetries = 0; connectSocket(); } });
}

async function bootstrap() {
  bindEvents(); ensureMap();
  if (localStorage.getItem('boatAdvanced') === '1') { $('advancedToggle').checked = true; document.body.classList.add('advanced'); }
  /* 恢复上次填过的网络串口地址（连远端中继时常用） */
  const savedManual = localStorage.getItem('boatSerialManual');
  if (savedManual && $('serialManual')) { $('serialManual').value = savedManual; }
  renderBuiltinSpecies(); updateSpeciesForm(false); render(); connectSocket();
  try { await Promise.all([refreshPorts(), refreshStatus()]); } catch (error) { toast(`初始化未完成：${error.message}`, 'warning'); }
  ensureSelection(); if (!state.creatingZone) fillRegionForm(selectedZone()); state.regionMap.resetForm = captureRegionForm(); render(); window.setInterval(renderFreshness, 1000);
}

document.addEventListener('DOMContentLoaded', bootstrap);
