const DEFAULT_MAP_CENTER = [34.5000, 104.0000];
const DEFAULT_MAP_ZOOM = 4;
const BOAT_FOCUS_ZOOM = 16;

const state = {
  status: { connected: false, portPath: null, baudRate: null, partialBytes: 0, lastMessageAt: null },
  latestBoot: null, latestData: null, history: [], logs: [],
  zones: [], samples: [], latestSampleByZone: {},
  sampling: { status: 'idle', task: null, warning: null, config: {} },
  builtinSpecies: {}, riskAnalyses: {}, llmConfig: { provider: 'disabled', enabled: false },
  aiChat: { messagesByZone: {}, loading: false },
  socket: null, selectedTarget: null, selectedZoneId: null, selectedSampleIds: new Set(),
  map: { instance: null, boatMarker: null, targetMarker: null, zoneLayers: {}, samplePointMarkers: [], autoCenteredOnBoat: false },
  rawJsonExpanded: false,
};

const el = {};
const $ = id => document.getElementById(id);

function initElements() {
  const ids = [
    // header
    'advancedModeCheckbox', 'serverBadge', 'serialBadge',
    'settingsButton', 'settingsPanel', 'settingsClose',
    // telemetry panel
    'teleConnStatus', 'teleConnPort', 'teleConnBaud', 'teleConnLastMsg',
    'telePh', 'telePhRaw', 'telePhMv',
    'teleTurb', 'teleTurbRaw', 'teleTurbMv', 'teleTurbDout', 'teleTurbStatus',
    'teleTemp', 'teleTempValid',
    'teleGpsFix', 'teleGpsSat', 'teleGpsLat', 'teleGpsLon',
    'teleGpsRawLat', 'teleGpsRawLon', 'teleGpsBytes', 'teleGpsLines',
    'teleImuValid', 'teleImuRoll', 'teleImuPitch', 'teleImuYaw',
    'teleImuBytes', 'teleImuFrames',
    'teleNavState', 'teleNavDist', 'teleNavHeading',
    'teleSeq', 'teleMs', 'teleBootVer', 'teleBootDiv',
    'teleRawToggle', 'teleRawJson',
    // map
    'targetMap', 'recenterMapButton', 'clearTargetButton', 'sendTargetButton',
    // zone cards
    'zoneCards', 'addZoneBtn', 'analyzeAllButton',
    // quick commands
    'quickStopButton', 'quickStartButton', 'quickSensorButton',
    // motor test
    'motorLeftSlider', 'motorRightSlider', 'motorLeftValue', 'motorRightValue',
    'motorSendButton', 'motorStopButton',
    'motorForward', 'motorBackward', 'motorTurnLeft', 'motorTurnRight',
    // motor calibration
    'calLeftScaleSlider', 'calRightScaleSlider', 'calLeftScaleValue', 'calRightScaleValue',
    'calLeftOffsetInput', 'calRightOffsetInput', 'calSendButton',
    // motor calibration telemetry
    'teleMls', 'teleMrs', 'teleMlo', 'teleMro',
    // nav monitor
    'navMonState', 'navMonDist', 'navMonHeading', 'navMonTarget',
    // zone detail
    'zoneDetailCard', 'zoneDetailTitle', 'zoneEmptyCard',
    'detailPh', 'detailTemp', 'detailTurbidity', 'detailRisk',
    'detailSamplingStatus', 'detailAnalysis', 'detailSamples',
    'sendZoneTargetBtn', 'manualSampleBtn', 'clearZoneSamplesBtn',
    'editZoneBtn', 'deleteZoneBtn', 'analyzeZoneBtn',
    // AI chat
    'aiChatCard', 'aiChatMessages', 'aiChatInput', 'aiChatSendButton', 'aiAnalyzeButton',
    // settings drawer
    'portSelect', 'baudRateInput', 'refreshPortsButton', 'connectButton', 'disconnectButton',
    'sendInput', 'appendNewlineCheckbox', 'broadcastCheckbox', 'sendButton',
    'arrivalRadiusInput', 'fallbackRadiusInput', 'fallbackAfterInput',
    'targetTimeoutInput', 'stabilizationInput', 'sampleIntervalInput', 'sampleDurationInput',
    'saveSamplingConfigButton', 'cancelSamplingButton',
    'testPhInput', 'testTempInput', 'testTurbidityInput', 'testSampleButton',
    'llmProviderSelect', 'llmCloudEndpoint', 'llmCloudApiKey', 'llmCloudModel',
    'llmOllamaEndpoint', 'llmOllamaModel', 'saveLlmConfigButton',
    'deletedZoneSelect', 'recoverZoneButton',
    'sampleHistoryZoneFilter', 'deleteSelectedSamplesButton', 'sampleHistoryBody',
    'rawLog',
    // zone edit modal
    'zoneEditModal', 'zoneEditTitle', 'zoneEditClose', 'zoneEditCancel', 'zoneEditSave',
    'zoneNameInput', 'speciesModeSelect', 'builtinSpeciesSelect', 'customSpeciesInput',
    'customSpeciesRow',
    'phMinInput', 'phMaxInput', 'tempMinInput', 'tempMaxInput', 'turbidityMaxInput',
    'zoneLatInput', 'zoneLonInput', 'zoneLengthInput', 'zoneWidthInput',
  ];
  for (const id of ids) el[id] = $(id);
}

// --- Helpers ---
const fmt = v => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-';
const esc = v => String(v ?? '-').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const scaled = (v,d,n=2) => v==null?'-':(Number(v)/d).toFixed(n);
const latLon = v => v==null||Number(v)===0?'-':(Number(v)/1e7).toFixed(7);
const coord = v => v==null||Number.isNaN(+v)?'-':Number(v).toFixed(7);
const raw2coord = v => v==null||Number(v)===0?null:Number(v)/1e7;
const fixText = v => v==null||v===''?'-':Number(v)>0?`已定位(${v})`:'未定位';
const boolText = v => v==null||v===''?'-':Number(v)===1?'是':'否';
const turbStatusText = (d) => {
  if (!d) return { text: '-', cls: '' };
  const status = Number(d.tbv);
  if (status === 0) return { text: '无效', cls: 'tele-err' };
  if (status === 1) return { text: '有效', cls: 'tele-ok' };
  return { text: '-', cls: '' };
};
const setBadge = (e,c,t) => { if(!e)return; e.className=`badge ${c}`; e.innerHTML=`<span class="status-dot"></span>${esc(t)}`; };

const getVisible = () => state.zones.filter(z => !z.deletedAt);
const getDeleted = () => state.zones.filter(z => z.deletedAt);
const getZone = id => state.zones.find(z => z.id === id) || null;
const getSel = () => { const z = getZone(state.selectedZoneId); return z && !z.deletedAt ? z : getVisible()[0] || null; };
const ensureSel = () => { state.selectedZoneId = (getSel() || {}).id || null; };
const zc = z => z?.geometry?.center || null;
const zl = id => { const z = getZone(id); return z ? z.name : id || '-'; };

function boatCoords() {
  const d = state.latestData;
  if (!d || Number(d.fix) <= 0) return null;
  const lat = raw2coord(d.lat), lon = raw2coord(d.lon);
  return lat != null && lon != null ? { latitude: lat, longitude: lon } : null;
}

function riskLevel(sample, zone) {
  if (!sample) return { level: 'unknown', label: '未采样', hint: '暂无采样数据' };
  const t = zone?.speciesProfile?.thresholds;
  if (!t) return { level: 'unknown', label: '无阈值', hint: '未配置阈值' };
  const w = sample.water || {};
  if (w.ph == null || w.tempC == null || w.turbidity == null) return { level: 'unknown', label: '数据不全', hint: '字段不足' };
  if (w.ph < t.phMin || w.ph > t.phMax || w.tempC < t.tempMin || w.tempC > t.tempMax || w.turbidity > t.turbidityMax * 1.25) return { level: 'danger', label: '危险', hint: '超出适宜范围' };
  if (w.ph < t.phMin + 0.2 || w.ph > t.phMax - 0.2 || w.tempC < t.tempMin + 1 || w.tempC > t.tempMax - 1 || w.turbidity > t.turbidityMax) return { level: 'warning', label: '预警', hint: '接近边界' };
  return { level: 'normal', label: '正常', hint: '适宜范围' };
}

const srcText = s => s === 'serial' ? '正式' : s === 'manual' ? '手动' : s === 'advanced_test' ? '测试' : s || '-';
const phaseText = p => ({ navigating: '前往中', stabilizing: '稳定中', sampling: '采样中', paused_warning: '暂停', completed: '已完成', cancelled: '已取消' })[p] || '待机';
const navStateText = ns => ({ 0: '待机', 1: '导航中', 2: '区域保持', 3: 'GPS丢失' })[ns] ?? `未知(${ns})`;
const navStateClass = ns => ({ 0: 'nav-state-idle', 1: 'nav-state-navigating', 2: 'nav-state-holding', 3: 'nav-state-lost' })[ns] ?? '';

async function api(url, opts) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `请求失败 ${r.status}`);
  return j;
}

function applyStatus(r) {
  state.status = r.status || state.status;
  state.latestBoot = r.latestBoot || null;
  state.latestData = r.latestData || null;
  state.history = Array.isArray(r.history) ? r.history : [];
  state.logs = Array.isArray(r.logs) ? r.logs : [];
  state.zones = Array.isArray(r.zones) ? r.zones : state.zones;
  state.samples = Array.isArray(r.samples) ? r.samples : state.samples;
  state.latestSampleByZone = r.latestSampleByZone || state.latestSampleByZone;
  state.sampling = r.sampling || state.sampling;
  state.builtinSpecies = r.builtinSpecies || state.builtinSpecies;
  if (r.llmConfig) state.llmConfig = r.llmConfig;
  ensureSel();
}

// --- API calls ---
async function refreshPorts() {
  const prev = el.portSelect.value;
  const r = await api('/api/ports');
  const ports = r.ports || [];
  el.portSelect.innerHTML = '';
  if (!ports.length) { el.portSelect.innerHTML = '<option value="">未发现串口</option>'; return; }
  for (const p of ports) {
    const extra = [p.friendlyName, p.manufacturer].filter(Boolean).join(' / ');
    el.portSelect.innerHTML += `<option value="${esc(p.path)}">${esc(extra ? `${p.path} - ${extra}` : p.path)}</option>`;
  }
  el.portSelect.value = ports.find(p => p.path === prev)?.path || ports[0].path;
}
async function refreshStatus() { applyStatus(await api('/api/status')); render(); }
async function connectSerial() {
  if (!el.portSelect.value) { alert('请先选择串口'); return; }
  await api('/api/serial/open', { method: 'POST', body: JSON.stringify({ path: el.portSelect.value, baudRate: Number(el.baudRateInput.value) || 115200 }) });
  await refreshStatus();
}
async function disconnectSerial() { await api('/api/serial/close', { method: 'POST' }); await refreshStatus(); }
async function sendMessage() {
  const msg = el.sendInput.value;
  if (!msg.trim()) { alert('请输入内容'); return; }
  await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ message: msg, appendNewline: el.appendNewlineCheckbox.checked, broadcast: el.broadcastCheckbox.checked }) });
  el.sendInput.focus();
}
async function sendZoneTarget() {
  const zone = getSel(); const c = zc(zone);
  if (!zone || !c) { alert('请先选择区域'); return; }
  const r = await api('/api/targets/zone', { method: 'POST', body: JSON.stringify({ zoneId: zone.id }) });
  state.selectedTarget = { latitude: c.latitude, longitude: c.longitude };
  state.sampling = r.sampling || state.sampling;
  render();
}
async function saveZone(create, zoneId) {
  const body = {
    name: el.zoneNameInput.value, speciesMode: el.speciesModeSelect.value,
    speciesKey: el.builtinSpeciesSelect.value, customSpeciesName: el.customSpeciesInput.value,
    thresholds: { phMin: +el.phMinInput.value, phMax: +el.phMaxInput.value, tempMin: +el.tempMinInput.value, tempMax: +el.tempMaxInput.value, turbidityMax: +el.turbidityMaxInput.value },
    center: { latitude: +el.zoneLatInput.value, longitude: +el.zoneLonInput.value },
    lengthM: +el.zoneLengthInput.value, widthM: +el.zoneWidthInput.value,
  };
  const url = create ? '/api/zones' : `/api/zones/${encodeURIComponent(zoneId)}`;
  const r = await api(url, { method: create ? 'POST' : 'PUT', body: JSON.stringify(body) });
  state.zones = r.zones || state.zones;
  if (r.zone) state.selectedZoneId = r.zone.id;
  closeEditModal(); render();
}
async function deleteZone() {
  const zone = getSel(); if (!zone) return;
  if (!confirm(`确定删除 ${zone.name}？历史采样保留，可恢复。`)) return;
  const r = await api(`/api/zones/${encodeURIComponent(zone.id)}`, { method: 'DELETE' });
  state.zones = r.zones || state.zones; state.selectedZoneId = null; render();
}
async function recoverZone() {
  const id = el.deletedZoneSelect.value; if (!id) { alert('没有可恢复的区域'); return; }
  const r = await api(`/api/zones/${encodeURIComponent(id)}/recover`, { method: 'POST' });
  state.zones = r.zones || state.zones; state.selectedZoneId = id; render();
}
async function saveSamplingConfig() {
  const body = {
    arrivalRadiusM: +el.arrivalRadiusInput.value, fallbackRadiusM: +el.fallbackRadiusInput.value,
    fallbackAfterMs: +el.fallbackAfterInput.value * 1000, targetTimeoutMs: +el.targetTimeoutInput.value * 60000,
    stabilizationMs: +el.stabilizationInput.value * 1000, sampleIntervalMs: +el.sampleIntervalInput.value * 1000,
    sampleDurationMs: +el.sampleDurationInput.value * 60000,
  };
  state.sampling = (await api('/api/sampling/config', { method: 'PUT', body: JSON.stringify(body) })).sampling || state.sampling; render();
}
async function cancelSampling() { state.sampling = (await api('/api/sampling/cancel', { method: 'POST' })).sampling || state.sampling; render(); }
async function manualSample() {
  const zone = getSel(); if (!zone) return;
  const r = await api('/api/sampling/manual-sample', { method: 'POST', body: JSON.stringify({ zoneId: zone.id }) });
  state.samples = r.samples || state.samples; state.latestSampleByZone = r.latestSampleByZone || state.latestSampleByZone; render();
}
async function testSample() {
  const zone = getSel(); if (!zone) return;
  const r = await api('/api/sampling/test-sample', { method: 'POST', body: JSON.stringify({ zoneId: zone.id, ph: +el.testPhInput.value, tempC: +el.testTempInput.value, turbidity: +el.testTurbidityInput.value }) });
  state.samples = r.samples || state.samples; state.latestSampleByZone = r.latestSampleByZone || state.latestSampleByZone; render();
}
async function deleteZoneSamples() {
  const zone = getSel(); if (!zone) return;
  if (!confirm(`清空 ${zone.name} 的可见样本？`)) return;
  const r = await api(`/api/zones/${encodeURIComponent(zone.id)}/samples/delete`, { method: 'POST' });
  state.samples = r.samples || state.samples; state.latestSampleByZone = r.latestSampleByZone || state.latestSampleByZone; render();
}
async function deleteSelectedSamples() {
  const ids = Array.from(state.selectedSampleIds); if (!ids.length) { alert('请先勾选样本'); return; }
  if (!confirm(`删除 ${ids.length} 条样本？`)) return;
  const r = await api('/api/samples/delete', { method: 'POST', body: JSON.stringify({ ids }) });
  state.selectedSampleIds.clear(); state.samples = r.samples || state.samples; state.latestSampleByZone = r.latestSampleByZone || state.latestSampleByZone; render();
}
async function analyzeAll() { state.riskAnalyses = (await api('/api/analysis/risk/batch', { method: 'POST', body: '{}' })).analyses || {}; render(); }
async function analyzeZone() {
  const zone = getSel(); if (!zone) return;
  state.riskAnalyses[zone.id] = (await api('/api/analysis/risk', { method: 'POST', body: JSON.stringify({ zoneId: zone.id }) })).analysis; renderDetail();
}
async function sendAiChat(defaultQuestion) {
  const zone = getSel(); if (!zone) return;
  const text = String(defaultQuestion || el.aiChatInput?.value || '').trim() || '请分析该区域当前水质并给出养殖建议';
  const zoneMessages = state.aiChat.messagesByZone[zone.id] || [];
  state.aiChat.messagesByZone[zone.id] = zoneMessages;
  zoneMessages.push({ role: 'user', text, at: Date.now() });
  if (el.aiChatInput) el.aiChatInput.value = '';
  state.aiChat.loading = true;
  renderAiChat();
  try {
    const result = await api('/api/analysis/chat', { method: 'POST', body: JSON.stringify({ zoneId: zone.id, message: text }) });
    zoneMessages.push({ role: 'assistant', text: result.reply || 'AI 未返回内容', source: result.source, model: result.model, at: result.analyzedAt || Date.now() });
  } catch (error) {
    zoneMessages.push({ role: 'system', text: `AI 暂不可用：${error.message}`, at: Date.now() });
  } finally {
    state.aiChat.loading = false;
    renderAiChat();
  }
}
async function saveLlmConfig() {
  const body = { provider: el.llmProviderSelect.value, cloudEndpoint: el.llmCloudEndpoint.value, cloudApiKey: el.llmCloudApiKey.value, cloudModel: el.llmCloudModel.value, ollamaEndpoint: el.llmOllamaEndpoint.value, ollamaModel: el.llmOllamaModel.value };
  state.llmConfig = (await api('/api/analysis/config', { method: 'PUT', body: JSON.stringify(body) })).llmConfig || state.llmConfig; fillLlmForm(); render();
}

// --- Motor & Command ---
async function sendMotorCommand(l, r) {
  const msg = JSON.stringify({ t: 'motor', l: Math.round(l), r: Math.round(r) });
  await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ message: msg, appendNewline: true, broadcast: false }) });
}
async function sendCmd(cmd) {
  const msg = JSON.stringify({ t: 'cmd', cmd });
  await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ message: msg, appendNewline: true, broadcast: false }) });
}
async function sendCalibration() {
  const ls = Number(el.calLeftScaleSlider.value) / 100;
  const rs = Number(el.calRightScaleSlider.value) / 100;
  const lo = Number(el.calLeftOffsetInput.value) || 0;
  const ro = Number(el.calRightOffsetInput.value) || 0;
  const msg = JSON.stringify({ t: 'mcal', ls: +ls.toFixed(2), rs: +rs.toFixed(2), lo, ro });
  await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ message: msg, appendNewline: true, broadcast: false }) });
}

// --- WebSocket ---
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.socket = ws;
  ws.addEventListener('open', () => setBadge(el.serverBadge, 'badge-online', '系统已连接'));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.kind === 'snapshot') applyStatus(m);
    else if (m.kind === 'serial-status') state.status = m.status || state.status;
    else if (m.kind === 'serial-message') {
      state.status = m.status || state.status; state.latestBoot = m.latestBoot || state.latestBoot; state.latestData = m.latestData || state.latestData;
      if (m.entry) state.history = [m.entry, ...state.history].slice(0, 200);
      if (m.log) state.logs = [m.log, ...state.logs].slice(0, 400);
    } else if (m.kind === 'serial-log') { state.status = m.status || state.status; if (m.log) state.logs = [m.log, ...state.logs].slice(0, 400); }
    else if (m.kind === 'zones-updated') { state.zones = m.zones || state.zones; ensureSel(); }
    else if (m.kind === 'samples-updated') { state.samples = m.samples || state.samples; state.latestSampleByZone = m.latestSampleByZone || state.latestSampleByZone; }
    else if (m.kind === 'sample-created') {
      if (m.sample && !m.sample.deletedAt) state.samples = [m.sample, ...state.samples.filter(s => s.id !== m.sample.id)].slice(0, 500);
      state.latestSampleByZone = m.latestSampleByZone || state.latestSampleByZone; state.sampling = m.sampling || state.sampling;
    } else if (m.kind === 'sampling-update') state.sampling = m.sampling || state.sampling;
    else if (m.kind === 'serial-error') { state.status = m.status || state.status; alert(`串口错误：${m.message || '未知'}`); }
    render();
  });
  ws.addEventListener('close', () => { setBadge(el.serverBadge, 'badge-offline', '重连中'); setTimeout(connectSocket, 2000); });
}

// --- Map ---
function ensureMap() {
  if (state.map.instance || !el.targetMap || typeof L === 'undefined') return;
  const map = L.map(el.targetMap, { zoomControl: false, attributionControl: false }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  map.on('click', e => { state.selectedTarget = { latitude: +e.latlng.lat.toFixed(7), longitude: +e.latlng.lng.toFixed(7) }; render(); });
  state.map.instance = map;
}

function rectBounds(z) {
  const c = zc(z); if (!c || !z.geometry) return null;
  const mLat = 111320, mLon = 111320 * Math.cos(c.latitude * Math.PI / 180) || 111320;
  const hL = (z.geometry.lengthM || 0) / 2 / mLat, hW = (z.geometry.widthM || 0) / 2 / mLon;
  return [[c.latitude - hL, c.longitude - hW], [c.latitude + hL, c.longitude + hW]];
}

function zoneLabelHtml(z) {
  const s = state.latestSampleByZone[z.id] || null;
  const r = riskLevel(s, z);
  const t = state.sampling.task;
  const active = t && t.zoneId === z.id && ['navigating', 'stabilizing', 'sampling', 'paused_warning'].includes(t.phase);
  const ph = s?.water?.ph ?? '-', temp = s?.water?.tempC != null ? `${s.water.tempC}℃` : '-', turb = s?.water?.turbidity ?? '-';
  const src = s ? srcText(s.source) : '未采样';
  const pts = t?.samplePoints?.length || 0, cur = (t?.currentPointIndex || 0) + 1;
  return `<div class="zone-map-label-card">
    <div class="zone-map-label-title"><span>${esc(z.name)}</span><span class="zone-map-risk zone-map-risk-${esc(r.level)}">${esc(r.label)}</span></div>
    <div class="zone-map-label-species">${esc(z.speciesProfile?.label || '-')} · ${esc(src)}</div>
    <div class="zone-map-label-values">pH ${esc(ph)} ｜ ${esc(temp)} ｜ 浊 ${esc(turb)}</div>
    ${active ? `<div class="zone-map-label-task">${esc(phaseText(t.phase))} · ${cur}/${pts}</div>` : ''}
  </div>`;
}

function refreshRects() {
  const map = state.map.instance; if (!map || typeof L === 'undefined') return;
  const ids = new Set(getVisible().map(z => z.id));
  for (const [id, layer] of Object.entries(state.map.zoneLayers)) { if (!ids.has(id)) { map.removeLayer(layer); delete state.map.zoneLayers[id]; } }
  for (const z of getVisible()) {
    const b = rectBounds(z); if (!b) continue;
    const sel = z.id === state.selectedZoneId;
    const opts = { color: sel ? '#2cced2' : '#4caf7d', weight: sel ? 4 : 2, fillOpacity: sel ? 0.22 : 0.10, bubblingMouseEvents: false };
    if (!state.map.zoneLayers[z.id]) {
      const layer = L.rectangle(b, opts).addTo(map);
      layer.bindTooltip(zoneLabelHtml(z), { permanent: true, direction: 'center', className: 'zone-map-label', opacity: 1, interactive: false });
      layer.on('click', () => selectZone(z.id));
      state.map.zoneLayers[z.id] = layer;
    } else {
      state.map.zoneLayers[z.id].setBounds(b).setStyle(opts);
      const tt = state.map.zoneLayers[z.id].getTooltip(); if (tt) tt.setContent(zoneLabelHtml(z));
    }
  }
}

function refreshPts() {
  const map = state.map.instance; if (!map || typeof L === 'undefined') return;
  state.map.samplePointMarkers.forEach(m => map.removeLayer(m)); state.map.samplePointMarkers = [];
  const t = state.sampling.task; if (!t?.samplePoints?.length) return;
  const ci = t.currentPointIndex || 0;
  t.samplePoints.forEach((p, i) => {
    const cur = i === ci, past = i < ci;
    const color = cur ? '#2563eb' : past ? '#16a34a' : '#9ca3af';
    const sz = cur ? 9 : 6;
    const icon = L.divIcon({ className: '', html: `<div style="width:${sz}px;height:${sz}px;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:#fff;">${i + 1}</div>`, iconSize: [sz + 4, sz + 4], iconAnchor: [(sz + 4) / 2, (sz + 4) / 2] });
    state.map.samplePointMarkers.push(L.marker([p.latitude, p.longitude], { icon }).addTo(map));
  });
}

function refreshMarkers() {
  ensureMap(); const map = state.map.instance; if (!map || typeof L === 'undefined') return;
  refreshRects(); refreshPts();
  const bc = boatCoords();
  if (bc) {
    const ll = [bc.latitude, bc.longitude];
    if (!state.map.boatMarker) state.map.boatMarker = L.marker(ll).addTo(map).bindPopup('小船');
    else state.map.boatMarker.setLatLng(ll);
    if (!state.map.autoCenteredOnBoat) { map.setView(ll, BOAT_FOCUS_ZOOM); state.map.autoCenteredOnBoat = true; }
  } else if (state.map.boatMarker) { map.removeLayer(state.map.boatMarker); state.map.boatMarker = null; state.map.autoCenteredOnBoat = false; }
  if (state.selectedTarget) {
    const ll = [state.selectedTarget.latitude, state.selectedTarget.longitude];
    if (!state.map.targetMarker) state.map.targetMarker = L.marker(ll).addTo(map).bindPopup('目标');
    else state.map.targetMarker.setLatLng(ll);
  } else if (state.map.targetMarker) { map.removeLayer(state.map.targetMarker); state.map.targetMarker = null; }
}

// --- Zone selection ---
function selectZone(id) {
  state.selectedZoneId = id;
  const zone = getSel();
  if (zone) {
    const c = zc(zone);
    if (c) {
      state.selectedTarget = { latitude: c.latitude, longitude: c.longitude };
      state.map.instance?.panTo([c.latitude, c.longitude]);
    }
  }
  render();
}

// --- Edit modal ---
function openEditModal(create) {
  const zone = create ? null : getSel();
  el.zoneEditTitle.textContent = create ? '新增区域' : '编辑区域';
  el.zoneEditSave.onclick = () => saveZone(create, zone?.id).catch(e => alert(e.message));
  if (zone) populateForm(zone); else clearForm();
  el.zoneEditModal.style.display = '';
}
function closeEditModal() { el.zoneEditModal.style.display = 'none'; }
function populateForm(z) {
  el.zoneNameInput.value = z.name || '';
  el.speciesModeSelect.value = z.speciesProfile?.type || 'builtin';
  if (z.speciesProfile?.type === 'builtin') { el.builtinSpeciesSelect.value = z.speciesProfile.key || ''; el.customSpeciesInput.value = ''; }
  else { el.customSpeciesInput.value = z.speciesProfile?.label || ''; }
  const t = z.speciesProfile?.thresholds;
  if (t) { el.phMinInput.value = t.phMin ?? ''; el.phMaxInput.value = t.phMax ?? ''; el.tempMinInput.value = t.tempMin ?? ''; el.tempMaxInput.value = t.tempMax ?? ''; el.turbidityMaxInput.value = t.turbidityMax ?? ''; }
  el.zoneLatInput.value = z.geometry?.center?.latitude ?? '';
  el.zoneLonInput.value = z.geometry?.center?.longitude ?? '';
  el.zoneLengthInput.value = z.geometry?.lengthM ?? '';
  el.zoneWidthInput.value = z.geometry?.widthM ?? '';
  updateSpecies();
}
function clearForm() {
  [el.zoneNameInput, el.customSpeciesInput, el.phMinInput, el.phMaxInput, el.tempMinInput, el.tempMaxInput, el.turbidityMaxInput, el.zoneLatInput, el.zoneLonInput, el.zoneLengthInput, el.zoneWidthInput].forEach(i => { if (i) i.value = ''; });
  el.speciesModeSelect.value = 'builtin'; updateSpecies();
}
function updateSpecies() {
  const custom = el.speciesModeSelect.value === 'custom';
  if (el.customSpeciesRow) el.customSpeciesRow.style.display = custom ? '' : 'none';
  if (el.customSpeciesInput) el.customSpeciesInput.disabled = !custom;
  if (el.builtinSpeciesSelect) el.builtinSpeciesSelect.disabled = custom;
  [el.phMinInput, el.phMaxInput, el.tempMinInput, el.tempMaxInput, el.turbidityMaxInput].forEach(i => { if (i) i.disabled = !custom; });
  if (!custom && el.builtinSpeciesSelect) {
    const sp = state.builtinSpecies[el.builtinSpeciesSelect.value];
    if (sp?.thresholds) { el.phMinInput.value = sp.thresholds.phMin ?? ''; el.phMaxInput.value = sp.thresholds.phMax ?? ''; el.tempMinInput.value = sp.thresholds.tempMin ?? ''; el.tempMaxInput.value = sp.thresholds.tempMax ?? ''; el.turbidityMaxInput.value = sp.thresholds.turbidityMax ?? ''; }
  }
}
function fillLlmForm() {
  if (!el.llmProviderSelect) return;
  el.llmProviderSelect.value = state.llmConfig.provider || 'disabled';
  el.llmCloudEndpoint.value = state.llmConfig.cloudEndpoint || '';
  el.llmCloudApiKey.value = '';
  el.llmCloudModel.value = state.llmConfig.cloudModel || '';
  el.llmOllamaEndpoint.value = state.llmConfig.ollamaEndpoint || '';
  el.llmOllamaModel.value = state.llmConfig.ollamaModel || '';
}

// --- Render: Telemetry Panel ---
function renderTelemetry() {
  const d = state.latestData;
  const b = state.latestBoot;
  const s = state.status;
  const conn = Boolean(s.connected);

  // Connection
  setText('teleConnStatus', conn ? '已连接' : '未连接', conn ? 'tele-ok' : 'tele-err');
  setText('teleConnPort', s.portPath || '-');
  setText('teleConnBaud', s.baudRate || '-');
  setText('teleConnLastMsg', s.lastMessageAt ? timeSince(s.lastMessageAt) : '-');

  if (!d) {
    // No data yet — show boot info if available
    if (b) {
      setText('teleBootVer', b.v ?? '-');
      setText('teleBootDiv', b.div ?? (b.phdiv != null && b.tbdiv != null ? `pH ${(Number(b.phdiv) / 100).toFixed(2)} / 浊 ${(Number(b.tbdiv) / 100).toFixed(2)}` : '-'));
    }
    return;
  }

  // Water quality
  setText('telePh', d.ph != null ? scaled(d.ph, 100) : '-');
  setText('telePhRaw', d.phr ?? '-');
  setText('telePhMv', d.phmv != null ? `${d.phmv} mV` : '-');
  setText('teleTurb', d.tb ?? '-');
  setText('teleTurbRaw', d.tbr ?? '-');
  setText('teleTurbMv', d.tbmv != null ? `${d.tbmv} mV` : '-');
  setText('teleTurbDout', d.td != null ? (Number(d.td) ? 'HIGH' : 'LOW') : '-');
  const turbStatus = turbStatusText(d);
  setText('teleTurbStatus', turbStatus.text, turbStatus.cls);
  setText('teleTemp', Number(d.tv) === 1 ? scaled(d.tc, 100) : '-');
  setText('teleTempValid', Number(d.tv) === 1 ? '有效' : '无效', Number(d.tv) === 1 ? 'tele-ok' : 'tele-err');

  // GPS
  const fix = Number(d.fix);
  setText('teleGpsFix', fix > 0 ? `已定位(${fix})` : '未定位', fix > 0 ? 'tele-ok' : 'tele-warn');
  setText('teleGpsSat', d.sat ?? '-');
  setText('teleGpsLat', latLon(d.lat));
  setText('teleGpsLon', latLon(d.lon));
  setText('teleGpsRawLat', d.lat ?? '-');
  setText('teleGpsRawLon', d.lon ?? '-');
  setText('teleGpsBytes', d.gb ?? '-');
  setText('teleGpsLines', d.gl ?? '-');

  // IMU
  const iv = Number(d.iv);
  setText('teleImuValid', iv === 1 ? '有效' : '无效', iv === 1 ? 'tele-ok' : 'tele-warn');
  setText('teleImuRoll', iv === 1 ? scaled(d.ir, 100, 1) + '°' : '-');
  setText('teleImuPitch', iv === 1 ? scaled(d.ip, 100, 1) + '°' : '-');
  setText('teleImuYaw', iv === 1 ? scaled(d.iy, 100, 1) + '°' : '-');
  setText('teleImuBytes', d.ib ?? '-');
  setText('teleImuFrames', d.ia ?? '-');

  // Navigation
  const ns = d.ns;
  const nsText = navStateText(ns);
  setText('teleNavState', nsText, ns === 1 ? 'tele-ok' : ns === 2 ? 'tele-ok' : ns === 3 ? 'tele-err' : '');
  setText('teleNavDist', d.nd != null && ns != null && ns > 0 ? (Number(d.nd) / 100).toFixed(2) + ' m' : '-');
  setText('teleNavHeading', d.nt != null && ns != null && ns > 0 ? (Number(d.nt) / 100).toFixed(1) + '°' : '-');

  // Sequence
  setText('teleSeq', d.seq ?? '-');
  setText('teleMs', d.ms != null ? formatUptime(d.ms) : '-');

  // Boot
  if (b) {
    setText('teleBootVer', b.v ?? '-');
    setText('teleBootDiv', b.div ?? (b.phdiv != null && b.tbdiv != null ? `pH ${(Number(b.phdiv) / 100).toFixed(2)} / 浊 ${(Number(b.tbdiv) / 100).toFixed(2)}` : '-'));
  }

  // Motor calibration
  setText('teleMls', d.mls != null ? (Number(d.mls) / 100).toFixed(2) : '-');
  setText('teleMrs', d.mrs != null ? (Number(d.mrs) / 100).toFixed(2) : '-');
  setText('teleMlo', d.mlo ?? '-');
  setText('teleMro', d.mro ?? '-');

  // Raw JSON
  if (el.teleRawJson && el.teleRawJson.style.display !== 'none') {
    el.teleRawJson.textContent = JSON.stringify(d, null, 2);
  }
}

function setText(id, value, cls) {
  const e = el[id];
  if (!e) return;
  e.textContent = value;
  if (cls !== undefined) {
    e.className = 'tele-value';
    if (cls) e.classList.add(cls);
  }
}

function timeSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return '刚刚';
  if (ms < 60000) return Math.floor(ms / 1000) + 's前';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm前';
  return Math.floor(ms / 3600000) + 'h前';
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m${s % 60}s`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

// --- Render: Zone Cards ---
function renderZoneCards() {
  const zones = getVisible();
  if (!zones.length) { el.zoneCards.innerHTML = '<div class="empty-hint">暂无区域，点击上方新增</div>'; return; }
  el.zoneCards.innerHTML = zones.map(z => {
    const s = state.latestSampleByZone[z.id] || null;
    const r = riskLevel(s, z);
    const sel = z.id === state.selectedZoneId;
    const t = state.sampling.task;
    const active = t && t.zoneId === z.id && ['navigating', 'stabilizing', 'sampling', 'paused_warning'].includes(t.phase);
    const w = s?.water || {};
    const updatedAt = s ? fmt(s.savedAt || s.receivedAt) : '未采样';
    return `<div class="zone-card ${sel ? 'selected' : ''}" data-zid="${esc(z.id)}">
      <div class="zone-card-header">
        <div>
          <div class="zone-card-name">${esc(z.name)}</div>
          <div class="zone-card-species">${esc(z.speciesProfile?.label || '-')}</div>
        </div>
        <div class="zone-card-badges">
          <span class="risk-badge risk-${esc(r.level)}">${esc(r.label)}</span>
          ${active ? `<span class="sampling-badge">${esc(phaseText(t.phase))}</span>` : ''}
        </div>
      </div>
      <div class="zone-card-stats">
        <div class="zone-card-stat"><span class="zone-card-stat-label">pH</span><strong>${w.ph ?? '-'}</strong></div>
        <div class="zone-card-stat"><span class="zone-card-stat-label">水温</span><strong>${w.tempC != null ? w.tempC + '℃' : '-'}</strong></div>
        <div class="zone-card-stat"><span class="zone-card-stat-label">浊度</span><strong>${w.turbidity ?? '-'}</strong></div>
      </div>
      <div class="zone-card-footer">${esc(updatedAt)}${s ? ` · ${esc(srcText(s.source))}` : ''}</div>
    </div>`;
  }).join('');
}

// --- Render: Zone Detail ---
function renderDetail() {
  const zone = getSel();
  if (!zone) { el.zoneDetailCard.style.display = 'none'; el.zoneEmptyCard.style.display = ''; renderAiChat(); return; }
  el.zoneDetailCard.style.display = ''; el.zoneEmptyCard.style.display = 'none';
  const s = state.latestSampleByZone[zone.id] || null;
  const r = riskLevel(s, zone);
  const w = s?.water || {};
  const t = state.sampling.task;
  const active = t && t.zoneId === zone.id && ['navigating', 'stabilizing', 'sampling', 'paused_warning'].includes(t.phase);
  el.zoneDetailTitle.textContent = zone.name;
  el.detailPh.textContent = w.ph ?? '-';
  el.detailTemp.textContent = w.tempC != null ? `${w.tempC}℃` : '-';
  el.detailTurbidity.textContent = w.turbidity ?? '-';
  el.detailRisk.textContent = r.label;
  el.detailRisk.className = `risk-badge risk-${r.level}`;
  el.detailSamplingStatus.textContent = active ? `${phaseText(t.phase)} · 采样点 ${(t.currentPointIndex || 0) + 1}/${t.samplePoints?.length || 0}` : '';
  const analysis = state.riskAnalyses[zone.id];
  if (analysis) {
    const src = { anthropic: 'Anthropic', llm: 'LLM', rule: '规则', rule_fallback: '规则兜底' }[analysis.source] || analysis.source;
    el.detailAnalysis.innerHTML = `<span class="risk-badge risk-${analysis.level === 'normal' ? 'ok' : analysis.level}">${esc({ normal: '正常', warning: '预警', danger: '危险' }[analysis.level] || analysis.level)}</span> ${esc(analysis.summary)}<br><small class="muted-text">${esc(src)} · ${fmt(analysis.analyzedAt)}</small>`;
  } else { el.detailAnalysis.textContent = '尚未分析'; }
  const zoneSamples = state.samples.filter(s => s.zoneId === zone.id).slice(0, 10);
  el.detailSamples.innerHTML = zoneSamples.length ? zoneSamples.map(s =>
    `<div class="detail-sample-item"><span>${fmt(s.savedAt || s.receivedAt)}</span><span>${esc(srcText(s.source))}</span><span>pH ${s.water?.ph ?? '-'}</span><span>${s.water?.tempC != null ? s.water.tempC + '℃' : '-'}</span></div>`
  ).join('') : '暂无采样记录';
  el.sendZoneTargetBtn.disabled = !state.status.connected || Boolean(state.sampling.task);
  el.manualSampleBtn.disabled = !state.status.connected || !state.latestData;
  renderAiChat();
}

function renderAiChat() {
  if (!el.aiChatMessages) return;
  const zone = getSel();
  if (!zone) {
    el.aiChatMessages.innerHTML = '<div class="ai-empty">选择地图区域后，AI 会结合养殖对象、水质阈值和小船采样数据给出建议。</div>';
    if (el.aiAnalyzeButton) el.aiAnalyzeButton.disabled = true;
    if (el.aiChatSendButton) el.aiChatSendButton.disabled = true;
    if (el.aiChatInput) el.aiChatInput.disabled = true;
    return;
  }

  if (el.aiAnalyzeButton) el.aiAnalyzeButton.disabled = state.aiChat.loading;
  if (el.aiChatSendButton) el.aiChatSendButton.disabled = state.aiChat.loading;
  if (el.aiChatInput) el.aiChatInput.disabled = state.aiChat.loading;
  const messages = state.aiChat.messagesByZone[zone.id] || [];
  const provider = state.llmConfig?.provider === 'anthropic'
    ? `Anthropic 兼容 · ${state.llmConfig.anthropicModel || 'server env'}`
    : state.llmConfig?.enabled ? `LLM · ${state.llmConfig.provider}` : '规则兜底';
  const intro = messages.length ? '' : `<div class="ai-empty">当前选中 ${esc(zone.name)}。点击“生成建议”，AI 将结合 ${esc(zone.speciesProfile?.label || '养殖对象')} 阈值和最新采样给出建议。<br><small>${esc(provider)}</small></div>`;
  const items = messages.map(m => {
    const cls = m.role === 'user' ? 'ai-message-user' : m.role === 'assistant' ? 'ai-message-assistant' : 'ai-message-system';
    const source = m.source ? `<span class="ai-message-meta">${esc({ anthropic: 'Anthropic', llm: 'LLM', rule: '规则', rule_fallback: '规则兜底' }[m.source] || m.source)}${m.model ? ` · ${esc(m.model)}` : ''}</span>` : '';
    return `<div class="ai-message ${cls}">${esc(m.text)}${source}</div>`;
  }).join('');
  const loading = state.aiChat.loading ? '<div class="ai-message ai-message-system">AI 正在分析该区域的水质与养殖对象…</div>' : '';
  el.aiChatMessages.innerHTML = intro + items + loading;
  el.aiChatMessages.scrollTop = el.aiChatMessages.scrollHeight;
}

// --- Render: Nav Monitor ---
function renderNavMonitor() {
  const d = state.latestData;
  const ns = d ? d.ns : null;
  const nsText = navStateText(ns);
  el.navMonState.textContent = nsText;
  el.navMonState.className = 'nav-big-value ' + navStateClass(ns);
  el.navMonDist.textContent = d && d.nd != null && ns != null && ns > 0 ? (Number(d.nd) / 100).toFixed(2) + ' m' : '-';
  el.navMonHeading.textContent = d && d.nt != null && ns != null && ns > 0 ? (Number(d.nt) / 100).toFixed(1) + '°' : '-';
  const t = state.sampling.task;
  if (t && t.target) {
    el.navMonTarget.textContent = `目标: ${t.target.latitude?.toFixed(6)}, ${t.target.longitude?.toFixed(6)}`;
  } else if (state.selectedTarget) {
    el.navMonTarget.textContent = `选中: ${state.selectedTarget.latitude.toFixed(6)}, ${state.selectedTarget.longitude.toFixed(6)}`;
  } else {
    el.navMonTarget.textContent = '无目标';
  }
}

// --- Render: Settings ---
function renderSettings() {
  if (el.builtinSpeciesSelect) {
    const prev = el.builtinSpeciesSelect.value;
    el.builtinSpeciesSelect.innerHTML = Object.entries(state.builtinSpecies).map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join('');
    if (prev && state.builtinSpecies[prev]) el.builtinSpeciesSelect.value = prev;
  }
  const del = getDeleted();
  if (el.deletedZoneSelect) el.deletedZoneSelect.innerHTML = del.length ? del.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('') : '<option value="">无</option>';
  if (el.recoverZoneButton) el.recoverZoneButton.disabled = !del.length;
  const cfg = state.sampling.config || {};
  [[el.arrivalRadiusInput, cfg.arrivalRadiusM], [el.fallbackRadiusInput, cfg.fallbackRadiusM], [el.fallbackAfterInput, cfg.fallbackAfterMs / 1000], [el.targetTimeoutInput, cfg.targetTimeoutMs / 60000], [el.stabilizationInput, cfg.stabilizationMs / 1000], [el.sampleIntervalInput, cfg.sampleIntervalMs / 1000], [el.sampleDurationInput, cfg.sampleDurationMs / 60000]].forEach(([i, v]) => { if (i && document.activeElement !== i) i.value = v ?? ''; });
  if (el.cancelSamplingButton) el.cancelSamplingButton.disabled = !state.sampling.task;
  if (el.testSampleButton) el.testSampleButton.disabled = !getSel();
  if (el.sampleHistoryZoneFilter) {
    const prev = el.sampleHistoryZoneFilter.value;
    el.sampleHistoryZoneFilter.innerHTML = '<option value="">全部</option>' + getVisible().map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('');
    el.sampleHistoryZoneFilter.value = prev;
  }
  const filt = state.samples.filter(s => !el.sampleHistoryZoneFilter?.value || s.zoneId === el.sampleHistoryZoneFilter.value);
  if (el.sampleHistoryBody) {
    el.sampleHistoryBody.innerHTML = filt.length ? filt.map(s => `<tr><td><input type="checkbox" data-sid="${esc(s.id)}" ${state.selectedSampleIds.has(s.id) ? 'checked' : ''}></td><td>${fmt(s.savedAt || s.receivedAt)}</td><td>${esc(zl(s.zoneId))}</td><td>${esc(srcText(s.source))}</td><td>${s.water?.ph ?? '-'}</td><td>${s.water?.tempC != null ? s.water.tempC + '℃' : '-'}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-hint">暂无</td></tr>';
  }
  if (el.deleteSelectedSamplesButton) el.deleteSelectedSamplesButton.disabled = state.selectedSampleIds.size === 0;
  if (el.rawLog) el.rawLog.textContent = state.logs.length ? state.logs.slice().reverse().map(l => `[${fmt(l.timestamp)}] [${l.direction}] ${l.text}`).join('\n') : '暂无日志';
}

// --- Render: Main ---
function render() {
  const conn = Boolean(state.status.connected);
  setBadge(el.serialBadge, conn ? 'badge-online' : 'badge-offline', conn ? `串口 ${state.status.portPath}` : '串口未连接');
  renderTelemetry();
  refreshMarkers();
  renderZoneCards();
  renderDetail();
  renderNavMonitor();
  renderSettings();
}

// --- Events ---
function bind() {
  // Serial
  el.refreshPortsButton?.addEventListener('click', () => refreshPorts().catch(e => alert(e.message)));
  el.connectButton?.addEventListener('click', () => connectSerial().catch(e => alert(e.message)));
  el.disconnectButton?.addEventListener('click', () => disconnectSerial().catch(e => alert(e.message)));
  el.sendButton?.addEventListener('click', () => sendMessage().catch(e => alert(e.message)));

  // Zone targets & sampling
  el.sendZoneTargetBtn?.addEventListener('click', () => sendZoneTarget().catch(e => alert(e.message)));
  el.manualSampleBtn?.addEventListener('click', () => manualSample().catch(e => alert(e.message)));
  el.clearZoneSamplesBtn?.addEventListener('click', () => deleteZoneSamples().catch(e => alert(e.message)));
  el.analyzeZoneBtn?.addEventListener('click', () => analyzeZone().catch(e => alert(e.message)));
  el.analyzeAllButton?.addEventListener('click', () => analyzeAll().catch(e => alert(e.message)));

  // Zone CRUD
  el.editZoneBtn?.addEventListener('click', () => openEditModal(false));
  el.deleteZoneBtn?.addEventListener('click', () => deleteZone().catch(e => alert(e.message)));
  el.addZoneBtn?.addEventListener('click', () => openEditModal(true));
  el.recoverZoneButton?.addEventListener('click', () => recoverZone().catch(e => alert(e.message)));

  // Sampling config
  el.saveSamplingConfigButton?.addEventListener('click', () => saveSamplingConfig().catch(e => alert(e.message)));
  el.cancelSamplingButton?.addEventListener('click', () => cancelSampling().catch(e => alert(e.message)));
  el.testSampleButton?.addEventListener('click', () => testSample().catch(e => alert(e.message)));

  // LLM / AI chat
  el.saveLlmConfigButton?.addEventListener('click', () => saveLlmConfig().catch(e => alert(e.message)));
  el.aiAnalyzeButton?.addEventListener('click', () => sendAiChat('请分析该区域当前水质并给出养殖建议').catch(e => alert(e.message)));
  el.aiChatSendButton?.addEventListener('click', () => sendAiChat().catch(e => alert(e.message)));
  el.aiChatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') sendAiChat().catch(err => alert(err.message)); });

  // Sample management
  el.deleteSelectedSamplesButton?.addEventListener('click', () => deleteSelectedSamples().catch(e => alert(e.message)));
  el.speciesModeSelect?.addEventListener('change', updateSpecies);
  el.builtinSpeciesSelect?.addEventListener('change', updateSpecies);
  el.sampleHistoryZoneFilter?.addEventListener('change', () => { state.selectedSampleIds.clear(); render(); });
  el.sampleHistoryBody?.addEventListener('change', e => { if (!e.target.dataset.sid) return; if (e.target.checked) state.selectedSampleIds.add(e.target.dataset.sid); else state.selectedSampleIds.delete(e.target.dataset.sid); render(); });

  // Map
  el.recenterMapButton?.addEventListener('click', () => { const bc = boatCoords(); if (!bc) { alert('无 GPS 数据'); return; } state.map.instance.setView([bc.latitude, bc.longitude], BOAT_FOCUS_ZOOM); });
  el.clearTargetButton?.addEventListener('click', () => { state.selectedTarget = null; render(); });
  el.sendTargetButton?.addEventListener('click', async () => {
    if (!state.selectedTarget) { alert('请先点击地图选点'); return; }
    const msg = JSON.stringify({ t: 'target', lat: Math.round(state.selectedTarget.latitude * 1e7), lon: Math.round(state.selectedTarget.longitude * 1e7) });
    await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ message: msg, appendNewline: true, broadcast: false }) });
  });

  // Settings drawer
  el.settingsButton?.addEventListener('click', () => { el.settingsPanel.style.display = ''; });
  el.settingsClose?.addEventListener('click', () => { el.settingsPanel.style.display = 'none'; });
  document.querySelector('.settings-backdrop')?.addEventListener('click', () => { el.settingsPanel.style.display = 'none'; });

  // Zone edit modal
  el.zoneEditClose?.addEventListener('click', closeEditModal);
  el.zoneEditCancel?.addEventListener('click', closeEditModal);

  // Zone card click
  el.zoneCards?.addEventListener('click', e => { const card = e.target.closest('.zone-card'); if (card) selectZone(card.dataset.zid); });

  // Advanced mode
  el.advancedModeCheckbox?.addEventListener('change', () => {
    document.body.classList.toggle('show-advanced', el.advancedModeCheckbox.checked);
    localStorage.setItem('boatAdvanced', el.advancedModeCheckbox.checked ? '1' : '0');
    setTimeout(() => state.map.instance?.invalidateSize(), 150);
  });

  // Quick commands
  el.quickStopButton?.addEventListener('click', () => sendCmd('stop').catch(e => alert(e.message)));
  el.quickStartButton?.addEventListener('click', () => sendCmd('start').catch(e => alert(e.message)));
  el.quickSensorButton?.addEventListener('click', () => sendCmd('sensor').catch(e => alert(e.message)));

  // Motor test
  el.motorLeftSlider?.addEventListener('input', () => { el.motorLeftValue.textContent = el.motorLeftSlider.value; });
  el.motorRightSlider?.addEventListener('input', () => { el.motorRightValue.textContent = el.motorRightSlider.value; });
  el.motorSendButton?.addEventListener('click', () => sendMotorCommand(+el.motorLeftSlider.value, +el.motorRightSlider.value).catch(e => alert(e.message)));
  el.motorStopButton?.addEventListener('click', () => { el.motorLeftSlider.value = 0; el.motorRightSlider.value = 0; el.motorLeftValue.textContent = '0'; el.motorRightValue.textContent = '0'; sendMotorCommand(0, 0).catch(e => alert(e.message)); });
  el.motorForward?.addEventListener('click', () => { el.motorLeftSlider.value = 50; el.motorRightSlider.value = 50; el.motorLeftValue.textContent = '50'; el.motorRightValue.textContent = '50'; sendMotorCommand(50, 50).catch(e => alert(e.message)); });
  el.motorBackward?.addEventListener('click', () => { el.motorLeftSlider.value = -50; el.motorRightSlider.value = -50; el.motorLeftValue.textContent = '-50'; el.motorRightValue.textContent = '-50'; sendMotorCommand(-50, -50).catch(e => alert(e.message)); });
  el.motorTurnLeft?.addEventListener('click', () => { el.motorLeftSlider.value = -30; el.motorRightSlider.value = 30; el.motorLeftValue.textContent = '-30'; el.motorRightValue.textContent = '30'; sendMotorCommand(-30, 30).catch(e => alert(e.message)); });
  el.motorTurnRight?.addEventListener('click', () => { el.motorLeftSlider.value = 30; el.motorRightSlider.value = -30; el.motorLeftValue.textContent = '30'; el.motorRightValue.textContent = '-30'; sendMotorCommand(30, -30).catch(e => alert(e.message)); });

  // Motor calibration
  el.calLeftScaleSlider?.addEventListener('input', () => { el.calLeftScaleValue.textContent = (Number(el.calLeftScaleSlider.value) / 100).toFixed(2); });
  el.calRightScaleSlider?.addEventListener('input', () => { el.calRightScaleValue.textContent = (Number(el.calRightScaleSlider.value) / 100).toFixed(2); });
  el.calSendButton?.addEventListener('click', () => sendCalibration().catch(e => alert(e.message)));

  // Raw JSON toggle
  el.teleRawToggle?.addEventListener('click', () => {
    state.rawJsonExpanded = !state.rawJsonExpanded;
    el.teleRawJson.style.display = state.rawJsonExpanded ? '' : 'none';
    el.teleRawToggle.textContent = state.rawJsonExpanded ? '原始 JSON ▾' : '原始 JSON ▸';
    if (state.rawJsonExpanded && state.latestData) {
      el.teleRawJson.textContent = JSON.stringify(state.latestData, null, 2);
    }
  });
}

// --- Periodic update for time-since ---
setInterval(() => {
  if (el.teleConnLastMsg && state.status.lastMessageAt) {
    el.teleConnLastMsg.textContent = timeSince(state.status.lastMessageAt);
  }
}, 1000);

async function bootstrap() {
  initElements();
  if (localStorage.getItem('boatAdvanced') === '1' && el.advancedModeCheckbox) {
    el.advancedModeCheckbox.checked = true;
    document.body.classList.add('show-advanced');
  }
  bind(); ensureMap(); fillLlmForm(); connectSocket();
  try { await refreshPorts(); await refreshStatus(); } catch (e) { alert(e.message); }
  render();
}

bootstrap();
