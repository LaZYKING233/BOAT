const els = {
  portPath: document.querySelector('#portPath'),
  baudRate: document.querySelector('#baudRate'),
  saveDir: document.querySelector('#saveDir'),
  fileName: document.querySelector('#fileName'),
  overwrite: document.querySelector('#overwrite'),
  targetSensor: document.querySelector('#targetSensor'),
  manualLabel: document.querySelector('#manualLabel'),
  faultType: document.querySelector('#faultType'),
  sceneLabel: document.querySelector('#sceneLabel'),
  note: document.querySelector('#note'),
  refreshPorts: document.querySelector('#refreshPorts'),
  startBtn: document.querySelector('#startBtn'),
  stopBtn: document.querySelector('#stopBtn'),
  message: document.querySelector('#message'),
  stateBadge: document.querySelector('#stateBadge'),
  rowCount: document.querySelector('#rowCount'),
  rxLineCount: document.querySelector('#rxLineCount'),
  jsonCount: document.querySelector('#jsonCount'),
  parseErrorCount: document.querySelector('#parseErrorCount'),
  filePath: document.querySelector('#filePath'),
  sessionId: document.querySelector('#sessionId'),
  lastMessageAt: document.querySelector('#lastMessageAt'),
  lastError: document.querySelector('#lastError'),
  preview: document.querySelector('#preview'),
};

function setMessage(text, isError = false) {
  els.message.textContent = text || '';
  els.message.style.color = isError ? '#c34141' : '';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `请求失败: ${response.status}`);
  return data;
}

function setBadge(active, hasError) {
  els.stateBadge.classList.toggle('active', active && !hasError);
  els.stateBadge.classList.toggle('idle', !active && !hasError);
  els.stateBadge.classList.toggle('error', Boolean(hasError));
  els.stateBadge.textContent = hasError ? '错误' : active ? '采集中' : '空闲';
}

function applyConfig(config) {
  els.baudRate.value = config.lastBaudRate || 115200;
  els.saveDir.value = config.lastSaveDir || '';
  els.fileName.value = config.lastFileName || '';
  els.targetSensor.value = config.lastTargetSensor || 'temperature';
  els.manualLabel.value = config.lastManualLabel || 'normal';
  els.faultType.value = config.lastFaultType || 'none';
  els.sceneLabel.value = config.lastSceneLabel || '';
  els.note.value = config.lastNote || '';
  els.portPath.dataset.lastPort = config.lastPort || '';
}

async function loadConfig() {
  const data = await api('/api/config');
  applyConfig(data.config || {});
}

async function refreshPorts() {
  const selected = els.portPath.value || els.portPath.dataset.lastPort;
  els.portPath.innerHTML = '';

  const data = await api('/api/ports');
  if (!data.ports || data.ports.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未发现串口';
    els.portPath.appendChild(option);
    return;
  }

  for (const port of data.ports) {
    const option = document.createElement('option');
    option.value = port.path;
    const name = port.friendlyName || port.manufacturer || '';
    option.textContent = name ? `${port.path} — ${name}` : port.path;
    els.portPath.appendChild(option);
  }

  if (selected && [...els.portPath.options].some((option) => option.value === selected)) {
    els.portPath.value = selected;
  }
}

function collectStartBody() {
  return {
    portPath: els.portPath.value,
    baudRate: Number(els.baudRate.value || 115200),
    saveDir: els.saveDir.value,
    fileName: els.fileName.value,
    overwrite: els.overwrite.checked,
    targetSensor: els.targetSensor.value,
    manualLabel: els.manualLabel.value,
    faultType: els.faultType.value,
    sceneLabel: els.sceneLabel.value,
    note: els.note.value,
  };
}

async function startCollecting() {
  setMessage('正在打开串口并创建 CSV...');
  els.startBtn.disabled = true;
  try {
    const data = await api('/api/start', {
      method: 'POST',
      body: JSON.stringify(collectStartBody()),
    });
    updateStatus(data.status);
    setMessage('采集已开始');
  } catch (error) {
    setMessage(error.message, true);
    await refreshStatus();
  }
}

async function stopCollecting() {
  setMessage('正在停止采集...');
  els.stopBtn.disabled = true;
  try {
    const data = await api('/api/stop', { method: 'POST', body: '{}' });
    updateStatus(data.status);
    setMessage('采集已停止，CSV 文件已关闭');
  } catch (error) {
    setMessage(error.message, true);
    await refreshStatus();
  }
}

function updateStatus(status = {}) {
  const active = Boolean(status.active);
  setBadge(active, status.lastError);
  els.startBtn.disabled = active;
  els.stopBtn.disabled = !active;

  els.rowCount.textContent = status.rowCount ?? 0;
  els.rxLineCount.textContent = status.rxLineCount ?? 0;
  els.jsonCount.textContent = status.jsonCount ?? 0;
  els.parseErrorCount.textContent = status.parseErrorCount ?? 0;
  els.filePath.textContent = status.filePath || '-';
  els.sessionId.textContent = status.sessionId || '-';
  els.lastMessageAt.textContent = status.lastMessageAt || '-';
  els.lastError.textContent = status.lastError || '-';
  els.preview.textContent = status.lastPreview ? JSON.stringify(status.lastPreview, null, 2) : '暂无数据';
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    updateStatus(status);
  } catch (error) {
    setMessage(error.message, true);
  }
}

els.refreshPorts.addEventListener('click', async () => {
  setMessage('正在刷新串口...');
  try {
    await refreshPorts();
    setMessage('串口列表已刷新');
  } catch (error) {
    setMessage(error.message, true);
  }
});

els.startBtn.addEventListener('click', startCollecting);
els.stopBtn.addEventListener('click', stopCollecting);

(async function init() {
  try {
    await loadConfig();
    await refreshPorts();
    await refreshStatus();
    setMessage('准备就绪');
  } catch (error) {
    setMessage(error.message, true);
  }

  setInterval(refreshStatus, 800);
})();
