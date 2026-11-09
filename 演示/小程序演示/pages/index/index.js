const STORAGE_KEY = 'boat-dashboard-server-v2'
const DEFAULT_IP = '192.168.8.100'
const DEFAULT_PORT = '8765'
const DEFAULT_BAUD = '115200'
const DEFAULT_MAP_CENTER = { latitude: 34.5, longitude: 104.0, scale: 15 }
const MAX_EVENT_LOGS = 60
const MAX_CHAT_MESSAGES = 24
const LLM_PROVIDERS = [
  { value: 'disabled', label: '禁用' },
  { value: 'cloud', label: '云端 API' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'anthropic', label: 'Anthropic 兼容' },
]
const SPECIES_MODES = [
  { value: 'builtin', label: '内置' },
  { value: 'custom', label: '自定义' },
]

function createEmptyZoneForm() {
  return {
    zoneId: '',
    name: '',
    speciesMode: 'builtin',
    speciesKey: '',
    customSpeciesName: '',
    phMin: '',
    phMax: '',
    tempMin: '',
    tempMax: '',
    turbidityMax: '',
    latitude: '',
    longitude: '',
    lengthM: '',
    widthM: '',
  }
}

function createEmptySamplingForm() {
  return {
    arrivalRadiusM: '',
    fallbackRadiusM: '',
    fallbackAfterMs: '',
    targetTimeoutMs: '',
    stabilizationMs: '',
    sampleIntervalMs: '',
    sampleDurationMs: '',
  }
}

function createEmptyLlmForm() {
  return {
    provider: 'disabled',
    cloudEndpoint: '',
    cloudApiKey: '',
    cloudModel: '',
    ollamaEndpoint: '',
    ollamaModel: '',
    anthropicConfigured: false,
    anthropicModel: '',
  }
}

function nowText() {
  return new Date().toLocaleTimeString()
}

function formatTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatDateTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatAgo(value) {
  if (!value) return '暂无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无'
  const diff = Date.now() - date.getTime()
  if (diff < 1000) return '刚刚'
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  return `${Math.floor(diff / 3600000)} 小时前`
}

function createOfflineSnapshot() {
  const now = new Date().toISOString()
  const waterByZone = {
    zone_A: { ph: 7.2, tempC: 24.0, turbidity: 15 },
    zone_B: { ph: 7.1, tempC: 23.5, turbidity: 18 },
    zone_C: { ph: 7.3, tempC: 24.5, turbidity: 14 },
    zone_D: { ph: 7.0, tempC: 22.8, turbidity: 12 },
    zone_E: { ph: 7.8, tempC: 25.2, turbidity: 16 },
  }
  const zones = [
    {
      id: 'zone_A', name: 'A区 草鱼塘', speciesProfile: { type: 'builtin', key: 'grass_carp', label: '草鱼', thresholds: { phMin: 6.5, phMax: 8.5, tempMin: 18, tempMax: 30, turbidityMax: 30 } },
      geometry: { type: 'axis_aligned_rectangle', center: { latitude: 34.5001, longitude: 104.0001 }, lengthM: 20, widthM: 10 },
      deletedAt: null, createdAt: now, updatedAt: now,
    },
    {
      id: 'zone_B', name: 'B区 鲫鱼塘', speciesProfile: { type: 'builtin', key: 'crucian_carp', label: '鲫鱼', thresholds: { phMin: 6.5, phMax: 8.5, tempMin: 16, tempMax: 30, turbidityMax: 35 } },
      geometry: { type: 'axis_aligned_rectangle', center: { latitude: 34.5003, longitude: 104.0003 }, lengthM: 20, widthM: 10 },
      deletedAt: null, createdAt: now, updatedAt: now,
    },
    {
      id: 'zone_C', name: 'C区 鲤鱼塘', speciesProfile: { type: 'builtin', key: 'carp', label: '鲤鱼', thresholds: { phMin: 6.5, phMax: 8.5, tempMin: 18, tempMax: 30, turbidityMax: 35 } },
      geometry: { type: 'axis_aligned_rectangle', center: { latitude: 34.5005, longitude: 104.0005 }, lengthM: 20, widthM: 10 },
      deletedAt: null, createdAt: now, updatedAt: now,
    },
    {
      id: 'zone_D', name: 'D区 鲈鱼塘', speciesProfile: { type: 'builtin', key: 'bass', label: '鲈鱼', thresholds: { phMin: 7.0, phMax: 8.5, tempMin: 20, tempMax: 30, turbidityMax: 25 } },
      geometry: { type: 'axis_aligned_rectangle', center: { latitude: 34.5007, longitude: 104.0007 }, lengthM: 20, widthM: 10 },
      deletedAt: null, createdAt: now, updatedAt: now,
    },
    {
      id: 'zone_E', name: 'E区 虾塘', speciesProfile: { type: 'builtin', key: 'shrimp', label: '虾', thresholds: { phMin: 7.5, phMax: 8.8, tempMin: 20, tempMax: 32, turbidityMax: 30 } },
      geometry: { type: 'axis_aligned_rectangle', center: { latitude: 34.5009, longitude: 104.0009 }, lengthM: 20, widthM: 10 },
      deletedAt: null, createdAt: now, updatedAt: now,
    },
  ]
  const samples = []
  const latestSampleByZone = {}
  const riskAnalyses = {}
  zones.forEach((zone) => {
    const water = waterByZone[zone.id]
    const sample = {
      id: `offline-${zone.id}`,
      zoneId: zone.id,
      water,
      source: 'serial',
      savedAt: now,
      receivedAt: now,
      gpsValidation: { validated: true, arrivalMode: 'gps_inside_zone', distanceToTargetM: 0 },
    }
    samples.push(sample)
    latestSampleByZone[zone.id] = sample
    riskAnalyses[zone.id] = {
      level: 'normal',
      summary: '当前水质处于适宜范围',
      reasons: [],
      suggestions: ['继续保持当前养殖管理', '定期监测水质变化'],
      confidence: 'high',
      source: 'rule',
      analyzedAt: now,
    }
  })
  return { zones, samples, latestSampleByZone, riskAnalyses, selectedZoneId: zones[0].id }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

function clampIndex(index, length) {
  if (!length) return 0
  if (index < 0) return 0
  if (index >= length) return length - 1
  return index
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function metersPerLongitude(latitude) {
  const result = 111320 * Math.cos(latitude * Math.PI / 180)
  return Math.abs(result) > 1 ? Math.abs(result) : 111320
}

function rawToCoordinate(value) {
  if (value === null || value === undefined || Number(value) === 0) return null
  return Number(value) / 1e7
}

function boatCoords(latestData) {
  if (!latestData || Number(latestData.fix) <= 0) return null
  const latitude = rawToCoordinate(latestData.lat)
  const longitude = rawToCoordinate(latestData.lon)
  if (latitude === null || longitude === null) return null
  return { latitude, longitude }
}

function buildRectanglePoints(zone) {
  const geometry = zone && zone.geometry
  const center = geometry && geometry.center
  if (!center) return []
  const halfLat = (Number(geometry.lengthM) || 0) / 2 / 111320
  const halfLon = (Number(geometry.widthM) || 0) / 2 / metersPerLongitude(center.latitude)
  return [
    { latitude: center.latitude - halfLat, longitude: center.longitude - halfLon },
    { latitude: center.latitude - halfLat, longitude: center.longitude + halfLon },
    { latitude: center.latitude + halfLat, longitude: center.longitude + halfLon },
    { latitude: center.latitude + halfLat, longitude: center.longitude - halfLon },
  ]
}

function getVisibleZones(zones) {
  return (zones || []).filter((zone) => !zone.deletedAt)
}

function getDeletedZones(zones) {
  return (zones || []).filter((zone) => zone.deletedAt)
}

function getSelectedZone(zones, selectedZoneId) {
  const visible = getVisibleZones(zones)
  if (!visible.length) return null
  const found = visible.find((zone) => zone.id === selectedZoneId)
  return found || visible[0]
}

function getRisk(sample, zone) {
  if (!sample) return { level: 'unknown', label: '未采样', hint: '暂无采样数据' }
  const thresholds = zone && zone.speciesProfile && zone.speciesProfile.thresholds
  if (!thresholds) return { level: 'unknown', label: '未配置', hint: '未配置阈值' }
  const water = sample.water || {}
  if (water.ph === null || water.ph === undefined || water.tempC === null || water.tempC === undefined || water.turbidity === null || water.turbidity === undefined) {
    return { level: 'unknown', label: '数据不全', hint: '采样字段不足' }
  }
  if (water.ph < thresholds.phMin || water.ph > thresholds.phMax || water.tempC < thresholds.tempMin || water.tempC > thresholds.tempMax || water.turbidity > thresholds.turbidityMax * 1.25) {
    return { level: 'danger', label: '危险', hint: '关键指标超出范围' }
  }
  if (water.ph < thresholds.phMin + 0.2 || water.ph > thresholds.phMax - 0.2 || water.tempC < thresholds.tempMin + 1 || water.tempC > thresholds.tempMax - 1 || water.turbidity > thresholds.turbidityMax) {
    return { level: 'warning', label: '预警', hint: '指标接近边界' }
  }
  return { level: 'normal', label: '正常', hint: '指标处于适宜范围' }
}

function riskClass(level) {
  return `risk-${level || 'unknown'}`
}

function sampleSourceText(source) {
  if (source === 'serial') return '自动'
  if (source === 'manual') return '手动'
  if (source === 'advanced_test') return '测试'
  return source || '未知'
}

function samplingPhaseText(phase) {
  const map = {
    navigating: '前往中',
    stabilizing: '稳定中',
    sampling: '采样中',
    paused_warning: '暂停',
    completed: '已完成',
    cancelled: '已取消',
  }
  return map[phase] || '待机'
}

function navStateText(value) {
  const map = { 0: '待机', 1: '导航中', 2: '区域保持', 3: 'GPS 丢失' }
  if (value === null || value === undefined || value === '') return '-'
  return map[value] || `未知(${value})`
}

function levelText(level) {
  const map = { normal: '正常', warning: '预警', danger: '危险', unknown: '未知' }
  return map[level] || level || '未知'
}

function formatCoord(value) {
  if (value === null || value === undefined) return '-'
  return Number(value).toFixed(6)
}

function sanitizeLocationData(data) {
  if (data == null || typeof data !== 'object') return data
  if (Array.isArray(data)) return data.map(sanitizeLocationData)
  const copy = {}
  for (const [k, v] of Object.entries(data)) {
    if (['lat', 'lon', 'latitude', 'longitude'].includes(k)) copy[k] = '隐藏'
    else copy[k] = sanitizeLocationData(v)
  }
  return copy
}

function sanitizeLogText(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/"lat"\s*:\s*-?\d+(\.\d+)?/g, '"lat":"隐藏"')
    .replace(/"lon"\s*:\s*-?\d+(\.\d+)?/g, '"lon":"隐藏"')
    .replace(/"latitude"\s*:\s*-?\d+(\.\d+)?/g, '"latitude":"隐藏"')
    .replace(/"longitude"\s*:\s*-?\d+(\.\d+)?/g, '"longitude":"隐藏"')
}

function formatThresholds(zone) {
  const thresholds = zone && zone.speciesProfile && zone.speciesProfile.thresholds
  if (!thresholds) return '未配置阈值'
  return `pH ${thresholds.phMin}~${thresholds.phMax} · 水温 ${thresholds.tempMin}~${thresholds.tempMax}℃ · 浊度 ≤ ${thresholds.turbidityMax}NTU`
}

function joinReasons(analysis) {
  const reasons = (analysis && analysis.reasons) || []
  return reasons.length ? reasons.join('；') : '暂无详细原因'
}

function portLabel(port) {
  if (!port) return '未发现串口'
  const extra = [port.friendlyName, port.manufacturer].filter(Boolean).join(' / ')
  return extra ? `${port.path} - ${extra}` : port.path
}

function buildZonePayload(form) {
  const payload = {
    name: form.name,
    speciesMode: form.speciesMode,
    speciesKey: form.speciesKey,
    customSpeciesName: form.customSpeciesName,
    thresholds: {
      phMin: numberOrNull(form.phMin),
      phMax: numberOrNull(form.phMax),
      tempMin: numberOrNull(form.tempMin),
      tempMax: numberOrNull(form.tempMax),
      turbidityMax: numberOrNull(form.turbidityMax),
    },
    center: {
      latitude: numberOrNull(form.latitude),
      longitude: numberOrNull(form.longitude),
    },
    lengthM: numberOrNull(form.lengthM),
    widthM: numberOrNull(form.widthM),
  }
  if (form.zoneId) payload.zoneId = form.zoneId
  return payload
}

Page({
  data: {
    // 选项卡核心分流状态 (新增：控制全局面板分流)
    currentTab: 'monitor', // 'monitor' (数据监视) | 'control' (设备控制) | 'config' (高级配置)

    ip: DEFAULT_IP,
    port: DEFAULT_PORT,
    wsUrl: '',
    connectionPhase: 'disconnected',
    connectionText: '未连接',
    boatText: '设备离线',
    lastSocketText: '暂无',
    lastDataText: '暂无',
    connected: false,
    canSend: false,
    advancedMode: false,

    // 点击连接后直接显示界面，不等待真实 WebSocket 握手；隐藏地图与 GPS 坐标
    instantDisplay: true,
    hideLocation: true,

    status: {
      connected: false,
      portPath: null,
      baudRate: null,
      partialBytes: 0,
      lastMessageAt: null,
      demoMode: false,
      serialAvailable: true,
    },
    latestBoot: null,
    latestData: null,
    latestDataReceivedAt: null,

    zones: [],
    samples: [],
    latestSampleByZone: {},
    sampling: {
      status: 'idle',
      task: null,
      warning: null,
      config: {},
    },
    builtinSpecies: {
      grass_carp: { label: '草鱼', thresholds: { phMin: 6.5, phMax: 8.5, tempMin: 18, tempMax: 30, turbidityMax: 30 } },
      crucian_carp: { label: '鲫鱼', thresholds: { phMin: 6.5, phMax: 8.5, tempMin: 16, tempMax: 30, turbidityMax: 35 } },
      carp: { label: '鲤鱼', thresholds: { phMin: 6.5, phMax: 8.5, tempMin: 18, tempMax: 30, turbidityMax: 35 } },
      bass: { label: '鲈鱼', thresholds: { phMin: 7.0, phMax: 8.5, tempMin: 20, tempMax: 30, turbidityMax: 25 } },
      shrimp: { label: '虾', thresholds: { phMin: 7.5, phMax: 8.8, tempMin: 20, tempMax: 32, turbidityMax: 30 } },
      crab: { label: '蟹', thresholds: { phMin: 7.5, phMax: 8.8, tempMin: 20, tempMax: 30, turbidityMax: 30 } },
    },
    riskAnalyses: {},
    selectedZoneId: '',
    selectedTarget: null,

    ports: [],
    portLabels: ['未发现串口'],
    portIndex: 0,
    baudRateInput: DEFAULT_BAUD,
    sendInput: '',
    appendNewline: true,
    broadcastMode: false,

    metricCards: [],
    telemetryRows: [],
    zoneCards: [],
    selectedZoneView: null,

    mapLatitude: DEFAULT_MAP_CENTER.latitude,
    mapLongitude: DEFAULT_MAP_CENTER.longitude,
    mapScale: DEFAULT_MAP_CENTER.scale,
    polygons: [],
    circles: [],

    eventLogs: [],
    rawLogText: '暂无日志',
    historyItems: [],
    rawJsonText: '{}',

    aiMessagesByZone: {},
    chatMessages: [],
    chatInput: '',

    sampleFilterOptions: [{ value: '', label: '全部区域' }],
    sampleFilterLabels: ['全部区域'],
    sampleFilterIndex: 0,
    sampleHistoryItems: [],
    selectedSampleIds: [],

    deletedZoneOptions: [{ value: '', label: '无可恢复区域' }],
    deletedZoneLabels: ['无可恢复区域'],
    deletedZoneIndex: 0,

    zoneEditorVisible: false,
    zoneEditorMode: 'create',
    zoneForm: createEmptyZoneForm(),
    speciesModeOptions: SPECIES_MODES,
    speciesModeLabels: SPECIES_MODES.map((item) => item.label),
    speciesModeIndex: 0,
    builtinSpeciesKeys: [],
    builtinSpeciesLabels: [],
    builtinSpeciesIndex: 0,

    samplingForm: createEmptySamplingForm(),
    testSampleForm: { ph: '7.20', tempC: '24.0', turbidity: '20' },

    llmProviderOptions: LLM_PROVIDERS,
    llmProviderLabels: LLM_PROVIDERS.map((item) => item.label),
    llmProviderIndex: 0,
    llmForm: createEmptyLlmForm(),

    motorLeft: '0',
    motorRight: '0',
    calLeftScale: '1.00',
    calRightScale: '1.00',
    calLeftOffset: '0',
    calRightOffset: '0',
  },

  onLoad() {
    const saved = wx.getStorageSync(STORAGE_KEY)
    if (saved && saved.ip && saved.port) {
      this.setData({
        ip: saved.ip,
        port: saved.port,
        advancedMode: !!saved.advancedMode,
        baudRateInput: saved.baudRateInput || DEFAULT_BAUD,
      })
    }
    this.refreshDerivedState(true)
    // 不自动连接，等待用户点击“连接”后直接显示
    // this.connectSocket()
    this._clockTimer = setInterval(() => this.refreshDerivedState(false), 1000)
  },

  onUnload() {
    this._manualClose = true
    this.clearReconnect()
    if (this._clockTimer) {
      clearInterval(this._clockTimer)
      this._clockTimer = null
    }
    this.closeSocket()
  },

  // 新增：极简 Tab 面板选择切换逻辑
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab) return
    this.setData({ currentTab: tab }, () => {
      // 切换视图时保持状态刷新，但不强制重置地图中心
      this.refreshDerivedState(false)
    })
  },

  saveLocalConfig() {
    wx.setStorageSync(STORAGE_KEY, {
      ip: this.data.ip,
      port: this.data.port,
      advancedMode: this.data.advancedMode,
      baudRateInput: this.data.baudRateInput,
    })
  },

  appendEventLog(text) {
    const item = `[${nowText()}] ${text}`
    const list = [item].concat(this.data.eventLogs || []).slice(0, MAX_EVENT_LOGS)
    this.setData({ eventLogs: list })
  },

  setFormField(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.setData({ [key]: e.detail.value })
  },

  onIpInput(e) {
    this.setData({ ip: e.detail.value })
  },

  onPortInput(e) {
    this.setData({ port: e.detail.value })
  },

  onChatInput(e) {
    this.setData({ chatInput: e.detail.value })
  },

  onAdvancedModeChange(e) {
    this.setData({ advancedMode: !!e.detail.value })
    this.saveLocalConfig()
  },

  onPortPickerChange(e) {
    this.setData({ portIndex: Number(e.detail.value) || 0 })
  },

  onSampleFilterChange(e) {
    this.setData({ sampleFilterIndex: Number(e.detail.value) || 0, selectedSampleIds: [] }, () => this.refreshDerivedState(false))
  },

  onDeletedZoneChange(e) {
    this.setData({ deletedZoneIndex: Number(e.detail.value) || 0 })
  },

  onSpeciesModeChange(e) {
    const index = Number(e.detail.value) || 0
    const mode = SPECIES_MODES[index].value
    this.setData({ speciesModeIndex: index, 'zoneForm.speciesMode': mode }, () => {
      if (mode === 'builtin') this.applyBuiltinSpeciesToForm(this.data.builtinSpeciesIndex)
    })
  },

  onBuiltinSpeciesChange(e) {
    const index = Number(e.detail.value) || 0
    this.setData({ builtinSpeciesIndex: index }, () => this.applyBuiltinSpeciesToForm(index))
  },

  onLlmProviderChange(e) {
    const index = Number(e.detail.value) || 0
    this.setData({ llmProviderIndex: index, 'llmForm.provider': LLM_PROVIDERS[index].value })
  },

  onSampleSelectionChange(e) {
    this.setData({ selectedSampleIds: e.detail.value || [] }, () => this.refreshDerivedState(false))
  },

  onAppendNewlineChange(e) {
    this.setData({ appendNewline: !!e.detail.value })
  },

  onBroadcastModeChange(e) {
    this.setData({ broadcastMode: !!e.detail.value })
  },

  closeSocket() {
    if (this._socketTask) {
      try {
        this._socketTask.close()
      } catch (error) {}
      this._socketTask = null
    }
  },

  clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  },

  scheduleReconnect() {
    this.clearReconnect()
    if (this._manualClose) return
    this._reconnectTimer = setTimeout(() => this.connectSocket(true), 2000)
  },

  toggleConnection() {
    if (this.data.connected || this.data.connectionPhase === 'connecting') {
      this._manualClose = true
      this.closeSocket()
      this.setData({
        connectionPhase: 'disconnected',
        connectionText: '已断开',
        connected: false,
        canSend: false,
      })
      this.appendEventLog('已主动断开服务端连接')
      return
    }

    // 点击连接后直接显示已连接界面，不等待真实 WebSocket 握手
    if (this.data.instantDisplay) {
      const latestData = {
        t: 'data', seq: 1, ms: Date.now() % 1000000,
        ph: 720, phr: 720, phmv: 0,
        tc: 2400, tv: 1,
        tb: 15, tbr: 1500, tbmv: 1500, td: 0, tbv: 1,
        fix: 1, sat: 8, lat: 345001000, lon: 1040001000, gb: 80, gl: 5,
        iv: 1, ir: 0, ip: 0, iy: 4500, ib: 0, ia: 0,
        aiphn: 1, aitn: 1,
        ns: 0, nd: 0, nh: 0,
        mls: 100, mrs: 100, mlo: 0, mro: 0,
      }
      const snapshot = createOfflineSnapshot()
      this.setData({
        connectionPhase: 'connected',
        connectionText: '已连接',
        connected: true,
        canSend: true,
        'status.connected': true,
        'status.demoMode': false,
        'status.serialAvailable': true,
        latestData,
        latestDataReceivedAt: new Date().toISOString(),
        ...snapshot,
      })
      this.appendEventLog('已连接服务')
      this.refreshDerivedState(false)
      // 后台继续尝试连接真实服务器，以便使用真实采样/AI 功能
      this.connectSocket()
      return
    }

    this.connectSocket()
  },

  connectSocket(isReconnect) {
    const ip = (this.data.ip || '').trim()
    const port = (this.data.port || '').trim()
    if (!ip || !port) {
      wx.showToast({ title: '请输入 IP 和端口', icon: 'none' })
      return
    }
    this._manualClose = false
    this.saveLocalConfig()
    this.clearReconnect()
    this.closeSocket()

    const url = `ws://${ip}:${port}`
    if (this.data.instantDisplay) {
      // 直接显示模式：保持前端已连接状态，仅记录同步连接日志
      this.setData({ wsUrl: url })
      this.appendEventLog(`${isReconnect ? '同步重连' : '同步连接'} ${url}`)
    } else {
      this.setData({
        wsUrl: url,
        connectionPhase: 'connecting',
        connectionText: isReconnect ? '重连中…' : '连接中…',
        connected: false,
        canSend: false,
      })
      this.appendEventLog(`${isReconnect ? '正在重连' : '正在连接'} ${url}`)
    }

    const socketTask = wx.connectSocket({ url })
    this._socketTask = socketTask
    this._realConnected = false

    socketTask.onOpen(() => {
      this._realConnected = true
      if (this.data.instantDisplay) {
        this.setData({ lastSocketText: '刚刚' })
        this.appendEventLog('服务端已连接，数据将同步更新')
      } else {
        this.setData({
          connectionPhase: 'connected',
          connectionText: '服务端已连接',
          connected: true,
          canSend: true,
          lastSocketText: '刚刚',
        })
        this.appendEventLog('服务端连接成功')
      }
      this.sendRaw({ type: 'hello', client: 'miniprogram', version: 2 })
      this.sendCommand('get_ports', {})
    })

    socketTask.onMessage((res) => {
      this.setData({ lastSocketText: '刚刚' })
      this.handleServerMessage(res.data)
    })

    socketTask.onClose(() => {
      const manual = this._manualClose
      this._realConnected = false
      if (this.data.instantDisplay && !manual) {
        this.appendEventLog('同步连接已关闭，界面保持')
        return
      }
      this.setData({
        connectionPhase: manual ? 'disconnected' : 'reconnecting',
        connectionText: manual ? '已断开' : '连接断开，重试中…',
        connected: false,
        canSend: false,
      })
      this.appendEventLog(manual ? '连接已关闭' : '连接意外关闭，准备重连')
      if (!manual) this.scheduleReconnect()
    })

    socketTask.onError((res) => {
      const message = res && res.errMsg ? res.errMsg : '未知错误'
      this._realConnected = false
      if (this.data.instantDisplay && !this._manualClose) {
        this.appendEventLog(`同步连接错误: ${message}，界面保持`)
        return
      }
      this.setData({
        connectionPhase: 'error',
        connectionText: '连接失败',
        connected: false,
        canSend: false,
      })
      this.appendEventLog(`连接错误: ${message}`)
      if (!this._manualClose) this.scheduleReconnect()
    })
  },

  sendRaw(payload) {
    if (!this._socketTask || !this.data.connected) {
      if (this.data.instantDisplay) {
        this.appendEventLog('同步连接未就绪，指令未发送')
        return false
      }
      wx.showToast({ title: '未连接服务端', icon: 'none' })
      return false
    }
    this._socketTask.send({
      data: JSON.stringify(payload),
      fail: (error) => {
        const message = error && error.errMsg ? error.errMsg : '发送失败'
        this.appendEventLog(message)
      },
    })
    return true
  },

  sendCommand(action, payload) {
    return this.sendRaw({ type: 'command', action, payload: payload || {} })
  },

  applyBuiltinSpeciesToForm(index) {
    const keys = this.data.builtinSpeciesKeys || []
    const key = keys[index]
    const species = key ? this.data.builtinSpecies[key] : null
    if (!species) return
    const thresholds = species.thresholds || {}
    this.setData({
      builtinSpeciesIndex: index,
      'zoneForm.speciesMode': 'builtin',
      'zoneForm.speciesKey': key,
      'zoneForm.customSpeciesName': '',
      'zoneForm.phMin': String(thresholds.phMin),
      'zoneForm.phMax': String(thresholds.phMax),
      'zoneForm.tempMin': String(thresholds.tempMin),
      'zoneForm.tempMax': String(thresholds.tempMax),
      'zoneForm.turbidityMax': String(thresholds.turbidityMax),
    })
  },

  syncSamplingForm() {
    const config = (this.data.sampling && this.data.sampling.config) || {}
    this.setData({
      samplingForm: {
        arrivalRadiusM: config.arrivalRadiusM !== undefined ? String(config.arrivalRadiusM) : '',
        fallbackRadiusM: config.fallbackRadiusM !== undefined ? String(config.fallbackRadiusM) : '',
        fallbackAfterMs: config.fallbackAfterMs !== undefined ? String(config.fallbackAfterMs) : '',
        targetTimeoutMs: config.targetTimeoutMs !== undefined ? String(config.targetTimeoutMs) : '',
        stabilizationMs: config.stabilizationMs !== undefined ? String(config.stabilizationMs) : '',
        sampleIntervalMs: config.sampleIntervalMs !== undefined ? String(config.sampleIntervalMs) : '',
        sampleDurationMs: config.sampleDurationMs !== undefined ? String(config.sampleDurationMs) : '',
      },
    })
  },

  syncLlmForm() {
    const llm = this.data.llmForm || {}
    const provider = llm.provider || 'disabled'
    const index = Math.max(0, LLM_PROVIDERS.findIndex((item) => item.value === provider))
    this.setData({ llmProviderIndex: index })
  },

  applySnapshot(payload) {
    const llmConfig = payload.llmConfig || createEmptyLlmForm()
    const ports = payload.ports || []
    this.setData({
      status: payload.status || this.data.status,
      latestBoot: payload.latestBoot || null,
      latestData: payload.latestData || null,
      latestDataReceivedAt: payload.status ? payload.status.lastMessageAt : this.data.latestDataReceivedAt,
      zones: payload.zones || [],
      samples: payload.samples || [],
      latestSampleByZone: payload.latestSampleByZone || {},
      sampling: payload.sampling || this.data.sampling,
      builtinSpecies: payload.builtinSpecies || {},
      riskAnalyses: payload.riskAnalyses || {},
      selectedTarget: payload.selectedTarget !== undefined ? payload.selectedTarget : null,
      ports,
      portLabels: ports.length ? ports.map(portLabel) : ['未发现串口'],
      historyItems: payload.history || [],
      rawLogText: (payload.logs || []).length ? (payload.logs || []).slice().reverse().map((item) => sanitizeLogText(`[${formatDateTime(item.timestamp)}] [${item.direction}] ${item.text}`)).join('\n') : '暂无日志',
      rawJsonText: JSON.stringify(sanitizeLocationData(payload.latestData || {}), null, 2),
      llmForm: {
        provider: llmConfig.provider || 'disabled',
        cloudEndpoint: llmConfig.cloudEndpoint || '',
        cloudApiKey: '',
        cloudModel: llmConfig.cloudModel || '',
        ollamaEndpoint: llmConfig.ollamaEndpoint || '',
        ollamaModel: llmConfig.ollamaModel || '',
        anthropicConfigured: !!llmConfig.anthropicConfigured,
        anthropicModel: llmConfig.anthropicModel || '',
      },
    }, () => {
      this.syncSamplingForm()
      this.syncLlmForm()
      this.refreshDerivedState(true)
    })
  },

  handleServerMessage(raw) {
    const message = safeParseJson(raw)
    if (!message) {
      this.appendEventLog(`收到文本: ${raw}`)
      return
    }
    const payload = message.payload || {}

    if (message.type === 'snapshot') {
      this.applySnapshot(payload)
      this.appendEventLog('已接收初始快照')
      return
    }

    if (message.type === 'telemetry') {
      this.setData({
        status: payload.status || this.data.status,
        latestBoot: payload.latestBoot || this.data.latestBoot,
        latestData: payload.latestData || this.data.latestData,
        latestDataReceivedAt: payload.status ? payload.status.lastMessageAt : this.data.latestDataReceivedAt,
        selectedTarget: payload.selectedTarget !== undefined ? payload.selectedTarget : this.data.selectedTarget,
        rawJsonText: JSON.stringify(sanitizeLocationData(payload.latestData || {}), null, 2),
      }, () => this.refreshDerivedState(false))
      return
    }

    if (message.type === 'serial_status') {
      this.setData({ status: payload.status || this.data.status }, () => this.refreshDerivedState(false))
      return
    }

    if (message.type === 'serial_log') {
      const logs = this.data.rawLogText && this.data.rawLogText !== '暂无日志' ? this.data.rawLogText.split('\n') : []
      const log = payload.log
      const line = log ? sanitizeLogText(`[${formatDateTime(log.timestamp)}] [${log.direction}] ${log.text}`) : ''
      const nextText = line ? [line].concat(logs).slice(0, 160).join('\n') : this.data.rawLogText
      this.setData({
        rawLogText: nextText || '暂无日志',
        status: payload.status || this.data.status,
      })
      return
    }

    if (message.type === 'serial_message') {
      this.setData({
        status: payload.status || this.data.status,
        latestBoot: payload.latestBoot || this.data.latestBoot,
        latestData: payload.latestData || this.data.latestData,
        historyItems: payload.history || this.data.historyItems,
        rawJsonText: JSON.stringify(sanitizeLocationData(payload.latestData || {}), null, 2),
      }, () => this.refreshDerivedState(false))
      return
    }

    if (message.type === 'ports') {
      const ports = payload.ports || []
      this.setData({
        ports,
        portLabels: ports.length ? ports.map(portLabel) : ['未发现串口'],
        portIndex: clampIndex(this.data.portIndex, ports.length),
      })
      return
    }

    if (message.type === 'zones_updated') {
      this.setData({ zones: payload.zones || this.data.zones }, () => this.refreshDerivedState(false))
      return
    }

    if (message.type === 'samples_updated') {
      this.setData({
        samples: payload.samples || this.data.samples,
        latestSampleByZone: payload.latestSampleByZone || this.data.latestSampleByZone,
      }, () => this.refreshDerivedState(false))
      return
    }

    if (message.type === 'sample_created') {
      const sample = payload.sample
      const nextSamples = sample ? [sample].concat((this.data.samples || []).filter((item) => item.id !== sample.id)).slice(0, 500) : this.data.samples
      this.setData({
        samples: nextSamples,
        latestSampleByZone: payload.latestSampleByZone || this.data.latestSampleByZone,
        sampling: payload.sampling || this.data.sampling,
      }, () => this.refreshDerivedState(false))
      this.appendEventLog(`已保存样本: ${sample && sample.zoneId ? sample.zoneId : '未知区域'}`)
      return
    }

    if (message.type === 'sampling_update') {
      this.setData({
        sampling: payload.sampling || this.data.sampling,
        selectedTarget: payload.selectedTarget !== undefined ? payload.selectedTarget : this.data.selectedTarget,
      }, () => {
        this.syncSamplingForm()
        this.refreshDerivedState(false)
      })
      return
    }

    if (message.type === 'analysis_result') {
      const zoneId = payload.zoneId
      if (!zoneId || !payload.analysis) return
      const nextRisk = Object.assign({}, this.data.riskAnalyses)
      nextRisk[zoneId] = payload.analysis
      this.setData({ riskAnalyses: nextRisk }, () => this.refreshDerivedState(false))
      return
    }

    if (message.type === 'batch_analysis_result') {
      const nextRisk = Object.assign({}, this.data.riskAnalyses, payload.analyses || {})
      this.setData({ riskAnalyses: nextRisk }, () => this.refreshDerivedState(false))
      this.appendEventLog('已完成全部区域风险分析')
      return
    }

    if (message.type === 'chat_result') {
      const zoneId = payload.zoneId
      if (!zoneId) return
      const nextMessages = Object.assign({}, this.data.aiMessagesByZone)
      const zoneMessages = (nextMessages[zoneId] || []).slice()
      zoneMessages.push({
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: payload.reply || '暂无回复',
        meta: `${payload.source || 'rule'} · ${formatTime(payload.analyzedAt)}`,
      })
      nextMessages[zoneId] = zoneMessages.slice(-MAX_CHAT_MESSAGES)
      this.setData({ aiMessagesByZone: nextMessages }, () => this.refreshDerivedState(false))
      return
    }

    if (message.type === 'llm_config') {
      const llmConfig = payload.llmConfig || {}
      this.setData({
        llmForm: {
          provider: llmConfig.provider || 'disabled',
          cloudEndpoint: llmConfig.cloudEndpoint || '',
          cloudApiKey: '',
          cloudModel: llmConfig.cloudModel || '',
          ollamaEndpoint: llmConfig.ollamaEndpoint || '',
          ollamaModel: llmConfig.ollamaModel || '',
          anthropicConfigured: !!llmConfig.anthropicConfigured,
          anthropicModel: llmConfig.anthropicModel || '',
        },
      }, () => this.syncLlmForm())
      return
    }

    if (message.type === 'notice') {
      const text = payload.text || '收到服务端通知'
      this.appendEventLog(text)
      return
    }

    if (message.type === 'ack') {
      if (payload && payload.message) this.appendEventLog(payload.message)
      return
    }

    if (message.type === 'error') {
      const text = payload.message || message.message || '服务端返回错误'
      wx.showToast({ title: text, icon: 'none' })
      this.appendEventLog(`错误: ${text}`)
    }
  },

  refreshDerivedState(resetCenter) {
    const zones = this.data.zones || []
    const selectedZone = getSelectedZone(zones, this.data.selectedZoneId)
    const selectedZoneId = selectedZone ? selectedZone.id : ''
    const selectedTarget = this.data.selectedTarget || (this.data.sampling && this.data.sampling.task && this.data.sampling.task.target) || null
    const sampleFilterOptions = [{ value: '', label: '全部区域' }].concat(getVisibleZones(zones).map((zone) => ({ value: zone.id, label: zone.name })))
    const sampleFilterIndex = clampIndex(this.data.sampleFilterIndex, sampleFilterOptions.length)
    const sampleFilterValue = sampleFilterOptions[sampleFilterIndex] ? sampleFilterOptions[sampleFilterIndex].value : ''
    const deletedZoneOptions = getDeletedZones(zones).map((zone) => ({ value: zone.id, label: zone.name }))
    const deletedZoneIndex = clampIndex(this.data.deletedZoneIndex, Math.max(1, deletedZoneOptions.length))
    const visibleZones = getVisibleZones(zones)

    const zoneCards = visibleZones.map((zone) => {
      const sample = this.data.latestSampleByZone[zone.id] || null
      const risk = getRisk(sample, zone)
      const activeTask = this.data.sampling && this.data.sampling.task && this.data.sampling.task.zoneId === zone.id
      return {
        id: zone.id,
        name: zone.name,
        speciesLabel: zone.speciesProfile ? zone.speciesProfile.label : '未配置',
        phText: sample && sample.water && sample.water.ph !== undefined ? String(sample.water.ph) : '-',
        tempText: sample && sample.water && sample.water.tempC !== undefined ? `${sample.water.tempC}℃` : '-',
        turbidityText: sample && sample.water && sample.water.turbidity !== undefined ? `${sample.water.turbidity}NTU` : '-',
        updatedText: sample ? `${formatTime(sample.savedAt || sample.receivedAt)} · ${sampleSourceText(sample.source)}` : '暂无采样',
        riskLabel: risk.label,
        riskClass: riskClass(risk.level),
        samplingText: activeTask ? samplingPhaseText(this.data.sampling.task.phase) : '',
        selected: zone.id === selectedZoneId,
      }
    })

    const polygons = visibleZones.map((zone) => ({
      points: buildRectanglePoints(zone),
      strokeWidth: zone.id === selectedZoneId ? 4 : 2,
      strokeColor: zone.id === selectedZoneId ? '#1e40af' : '#475569',
      fillColor: zone.id === selectedZoneId ? '#1e40af22' : '#47556911',
      zIndex: zone.id === selectedZoneId ? 3 : 1,
    })).filter((item) => item.points.length === 4)

    const circles = []
    const boat = boatCoords(this.data.latestData)
    if (boat) {
      circles.push({ latitude: boat.latitude, longitude: boat.longitude, radius: 2.8, color: '#0f766e', fillColor: '#14b8a6aa', strokeWidth: 2 })
    }
    if (selectedTarget) {
      circles.push({ latitude: selectedTarget.latitude, longitude: selectedTarget.longitude, radius: 2, color: '#1d4ed8', fillColor: '#3b82f6aa', strokeWidth: 2 })
    }
    const task = this.data.sampling && this.data.sampling.task
    if (task && Array.isArray(task.samplePoints)) {
      task.samplePoints.forEach((point, index) => {
        circles.push({
          latitude: point.latitude,
          longitude: point.longitude,
          radius: index === task.currentPointIndex ? 1.8 : 1.2,
          color: index === task.currentPointIndex ? '#2563eb' : '#64748b',
          fillColor: index === task.currentPointIndex ? '#60a5faaa' : '#94a3b8aa',
          strokeWidth: 1,
        })
      })
    }

    // 比赛要求：隐藏地图与位置信息
    if (this.data.hideLocation) {
      polygons.length = 0
      circles.length = 0
    }

    const metricCards = [
      {
        key: 'ph',
        label: 'pH',
        value: this.data.latestData && this.data.latestData.ph !== undefined && this.data.latestData.ph !== null ? (Number(this.data.latestData.ph) / 100).toFixed(2) : '-',
        subtext: this.data.latestData && this.data.latestData.phr !== undefined && this.data.latestData.phr !== null ? `raw ${this.data.latestData.phr}` : '实时酸碱度',
      },
      {
        key: 'temp',
        label: '水温',
        value: this.data.latestData && Number(this.data.latestData.tv) === 1 && this.data.latestData.tc !== undefined && this.data.latestData.tc !== null ? `${(Number(this.data.latestData.tc) / 100).toFixed(2)}℃` : '-',
        subtext: this.data.latestData && Number(this.data.latestData.tv) === 1 ? '温度有效' : '暂未有效',
      },
      {
        key: 'turbidity',
        label: '浊度',
        value: this.data.latestData && this.data.latestData.tb !== undefined && this.data.latestData.tb !== null ? `${this.data.latestData.tb}NTU` : '-',
        subtext: this.data.latestData && this.data.latestData.tbmv !== undefined && this.data.latestData.tbmv !== null ? `${this.data.latestData.tbmv} mV` : '实时浊度',
      },
      {
        key: 'nav',
        label: '导航',
        value: navStateText(this.data.latestData && this.data.latestData.ns),
        subtext: this.data.latestData && this.data.latestData.nt !== undefined && this.data.latestData.nt !== null ? `航向误差 ${(Number(this.data.latestData.nt) / 100).toFixed(1)}°` : '等待目标',
      },
    ]

    const telemetryRows = [
      { label: '串口状态', value: this.data.status.connected ? '已连接' : '未连接' },
      { label: '设备标识', value: this.data.status.portPath || '-' },
      { label: '波特率', value: this.data.status.baudRate || '-' },
      { label: '最后消息', value: formatAgo(this.data.status.lastMessageAt) },
      { label: 'GPS', value: this.data.hideLocation ? (this.data.latestData && Number(this.data.latestData.fix) > 0 ? '已定位' : '未定位') : (this.data.latestData && Number(this.data.latestData.fix) > 0 ? `已定位(${this.data.latestData.sat || 0})` : '未定位') },
      { label: '坐标', value: '隐藏' },
      { label: 'IMU Yaw', value: this.data.latestData && Number(this.data.latestData.iv) === 1 && this.data.latestData.iy !== undefined ? `${(Number(this.data.latestData.iy) / 100).toFixed(1)}°` : '-' },
      { label: '导航状态', value: navStateText(this.data.latestData && this.data.latestData.ns) },
      { label: '目标距离', value: this.data.latestData && this.data.latestData.nd !== undefined && this.data.latestData.nd !== null ? `${(Number(this.data.latestData.nd) / 100).toFixed(2)} m` : '-' },
      { label: '采样任务', value: task ? samplingPhaseText(task.phase) : '空闲' },
      { label: '包序号', value: this.data.latestData && this.data.latestData.seq !== undefined ? String(this.data.latestData.seq) : '-' },
      { label: '运行时长', value: this.data.latestData && this.data.latestData.ms !== undefined ? `${Math.floor(Number(this.data.latestData.ms) / 1000)}s` : '-' },
    ]

    let selectedZoneView = null
    const selectedSample = selectedZone ? (this.data.latestSampleByZone[selectedZone.id] || null) : null
    const selectedRisk = selectedZone ? getRisk(selectedSample, selectedZone) : null
    const selectedAnalysis = selectedZone ? (this.data.riskAnalyses[selectedZone.id] || null) : null
    if (selectedZone) {
      const sampleItems = (this.data.samples || []).filter((sample) => sample.zoneId === selectedZone.id && !sample.deletedAt).slice(0, 10).map((sample) => ({
        id: sample.id,
        title: `${formatDateTime(sample.savedAt || sample.receivedAt)} · ${sampleSourceText(sample.source)}`,
        value: `pH ${sample.water && sample.water.ph !== undefined ? sample.water.ph : '-'} · 水温 ${sample.water && sample.water.tempC !== undefined ? sample.water.tempC : '-'}℃ · 浊度 ${sample.water && sample.water.turbidity !== undefined ? sample.water.turbidity : '-'}NTU`,
      }))
      selectedZoneView = {
        id: selectedZone.id,
        name: selectedZone.name,
        speciesLabel: selectedZone.speciesProfile ? selectedZone.speciesProfile.label : '未配置',
        thresholdsText: formatThresholds(selectedZone),
        centerText: '隐藏',
        riskLabel: selectedRisk ? selectedRisk.label : '未知',
        riskHint: selectedRisk ? selectedRisk.hint : '',
        riskClass: selectedRisk ? riskClass(selectedRisk.level) : 'risk-unknown',
        phText: selectedSample && selectedSample.water && selectedSample.water.ph !== undefined ? String(selectedSample.water.ph) : '-',
        tempText: selectedSample && selectedSample.water && selectedSample.water.tempC !== undefined ? `${selectedSample.water.tempC}℃` : '-',
        turbidityText: selectedSample && selectedSample.water && selectedSample.water.turbidity !== undefined ? `${selectedSample.water.turbidity}NTU` : '-',
        sampleTimeText: selectedSample ? `${formatDateTime(selectedSample.savedAt || selectedSample.receivedAt)} · ${sampleSourceText(selectedSample.source)}` : '暂无样本',
        samplingText: task && task.zoneId === selectedZone.id ? samplingPhaseText(task.phase) : '空闲',
        warningText: task && task.zoneId === selectedZone.id && task.warning ? task.warning : '',
        analysisSummary: selectedAnalysis ? selectedAnalysis.summary : '尚未分析',
        analysisMeta: selectedAnalysis ? `${levelText(selectedAnalysis.level)} · ${selectedAnalysis.source || 'rule'} · ${formatDateTime(selectedAnalysis.analyzedAt)}` : '点击“生成建议”进行分析',
        analysisReasons: selectedAnalysis ? joinReasons(selectedAnalysis) : '暂无',
        sampleItems,
      }
    }

    const chatMessages = selectedZone ? ((this.data.aiMessagesByZone[selectedZone.id] || []).slice(-MAX_CHAT_MESSAGES)) : []
    const sampleHistoryItems = (this.data.samples || [])
      .filter((sample) => !sample.deletedAt)
      .filter((sample) => !sampleFilterValue || sample.zoneId === sampleFilterValue)
      .map((sample) => ({
        id: sample.id,
        checked: (this.data.selectedSampleIds || []).indexOf(sample.id) !== -1,
        title: `${formatDateTime(sample.savedAt || sample.receivedAt)} · ${(visibleZones.find((zone) => zone.id === sample.zoneId) || {}).name || sample.zoneId || '-'}`,
        subtitle: `${sampleSourceText(sample.source)} · pH ${sample.water && sample.water.ph !== undefined ? sample.water.ph : '-'} · 水温 ${sample.water && sample.water.tempC !== undefined ? sample.water.tempC : '-'}℃ · 浊度 ${sample.water && sample.water.turbidity !== undefined ? sample.water.turbidity : '-'}NTU`,
      }))

    const builtinSpeciesKeys = Object.keys(this.data.builtinSpecies || {})
    const builtinSpeciesLabels = builtinSpeciesKeys.map((key) => this.data.builtinSpecies[key].label)
    let builtinSpeciesIndex = clampIndex(this.data.builtinSpeciesIndex, Math.max(1, builtinSpeciesKeys.length))
    if (this.data.zoneForm && this.data.zoneForm.speciesKey) {
      const foundIndex = builtinSpeciesKeys.indexOf(this.data.zoneForm.speciesKey)
      if (foundIndex >= 0) builtinSpeciesIndex = foundIndex
    }
    const llmProviderIndex = Math.max(0, LLM_PROVIDERS.findIndex((item) => item.value === ((this.data.llmForm || {}).provider || 'disabled')))

    let mapLatitude = this.data.mapLatitude
    let mapLongitude = this.data.mapLongitude
    let mapScale = this.data.mapScale
    if (resetCenter !== false) {
      const center = boat || (selectedZone && selectedZone.geometry && selectedZone.geometry.center) || DEFAULT_MAP_CENTER
      mapLatitude = center.latitude
      mapLongitude = center.longitude
      mapScale = center.scale || (boat ? 17 : 15)
    }

    this.setData({
      selectedZoneId,
      selectedTarget,
      connectionText: this.data.connectionPhase === 'connected' ? '服务端已连接' : this.data.connectionPhase === 'connecting' ? '连接中…' : this.data.connectionPhase === 'reconnecting' ? '重连中…' : this.data.connectionPhase === 'error' ? '连接失败' : '未连接',
      boatText: this.data.status.connected ? '设备在线' : '设备离线',
      lastDataText: formatAgo(this.data.status.lastMessageAt),
      metricCards,
      telemetryRows,
      zoneCards,
      selectedZoneView,
      polygons,
      circles,
      mapLatitude,
      mapLongitude,
      mapScale,
      chatMessages,
      sampleFilterOptions,
      sampleFilterLabels: sampleFilterOptions.map((item) => item.label),
      sampleFilterIndex,
      sampleHistoryItems,
      deletedZoneOptions: deletedZoneOptions.length ? deletedZoneOptions : [{ value: '', label: '无可恢复区域' }],
      deletedZoneLabels: deletedZoneOptions.length ? deletedZoneOptions.map((item) => item.label) : ['无可恢复区域'],
      deletedZoneIndex,
      builtinSpeciesKeys,
      builtinSpeciesLabels: builtinSpeciesLabels.length ? builtinSpeciesLabels : ['暂无内置物种'],
      builtinSpeciesIndex,
      llmProviderIndex,
      portIndex: clampIndex(this.data.portIndex, Math.max(1, this.data.ports.length)),
    })
  },

  selectZone(e) {
    const zoneId = e.currentTarget.dataset.id
    const zone = (this.data.zones || []).find((item) => item.id === zoneId)
    const updates = { selectedZoneId: zoneId }
    if (zone && zone.geometry && zone.geometry.center) {
      updates.mapLatitude = zone.geometry.center.latitude
      updates.mapLongitude = zone.geometry.center.longitude
      updates.mapScale = 17
    }
    this.setData(updates, () => this.refreshDerivedState(false))
  },

  recenterBoat() {
    if (this.data.hideLocation) return
    const boat = boatCoords(this.data.latestData)
    if (!boat) {
      wx.showToast({ title: '暂无 GPS 数据', icon: 'none' })
      return
    }
    this.setData({ mapLatitude: boat.latitude, mapLongitude: boat.longitude, mapScale: 17 })
  },

  onMapTap(e) {
    if (this.data.hideLocation) return
    const detail = e.detail || {}
    if (detail.latitude === undefined || detail.longitude === undefined) return
    const target = { latitude: Number(detail.latitude.toFixed(6)), longitude: Number(detail.longitude.toFixed(6)) }
    this.setData({ selectedTarget: target }, () => this.refreshDerivedState(false))
    this.appendEventLog('已选择地图目标（位置已隐藏）')
  },

  clearTarget() {
    this.setData({ selectedTarget: null }, () => this.refreshDerivedState(false))
    this.sendCommand('clear_target', {})
  },

  sendSelectedTarget() {
    const target = this.data.selectedTarget
    if (!target) {
      wx.showToast({ title: '请先点击地图选择目标', icon: 'none' })
      return
    }
    this.sendCommand('send_target', target)
  },

  sendQuickCommand(e) {
    const cmd = e.currentTarget.dataset.cmd
    if (!cmd) return
    this.sendCommand('quick_cmd', { cmd })
  },

  startZoneSampling() {
    const zone = getSelectedZone(this.data.zones, this.data.selectedZoneId)
    if (!zone) {
      wx.showToast({ title: '请先选择区域', icon: 'none' })
      return
    }
    this.sendCommand('start_zone_sampling', { zoneId: zone.id })
  },

  cancelSampling() {
    this.sendCommand('cancel_sampling', {})
  },

  manualSample() {
    const zone = getSelectedZone(this.data.zones, this.data.selectedZoneId)
    if (!zone) {
      wx.showToast({ title: '请先选择区域', icon: 'none' })
      return
    }
    this.sendCommand('manual_sample', { zoneId: zone.id })
  },

  sendTestSample() {
    const zone = getSelectedZone(this.data.zones, this.data.selectedZoneId)
    if (!zone) {
      wx.showToast({ title: '请先选择区域', icon: 'none' })
      return
    }
    const form = this.data.testSampleForm || {}
    this.sendCommand('test_sample', {
      zoneId: zone.id,
      ph: numberOrNull(form.ph),
      tempC: numberOrNull(form.tempC),
      turbidity: numberOrNull(form.turbidity),
    })
  },

  analyzeZone() {
    const zone = getSelectedZone(this.data.zones, this.data.selectedZoneId)
    if (!zone) {
      wx.showToast({ title: '请先选择区域', icon: 'none' })
      return
    }
    this.sendCommand('analyze_zone', { zoneId: zone.id })
  },

  analyzeAll() {
    this.sendCommand('analyze_all', {})
  },

  sendAiSuggestion() {
    const zone = getSelectedZone(this.data.zones, this.data.selectedZoneId)
    if (!zone) {
      wx.showToast({ title: '请先选择区域', icon: 'none' })
      return
    }
    const question = (this.data.chatInput || '').trim() || '请分析该区域当前水质并给出养殖建议'
    const nextMessages = Object.assign({}, this.data.aiMessagesByZone)
    const zoneMessages = (nextMessages[zone.id] || []).slice()
    zoneMessages.push({ id: `user-${Date.now()}`, role: 'user', text: question, meta: formatTime(new Date()) })
    nextMessages[zone.id] = zoneMessages.slice(-MAX_CHAT_MESSAGES)
    this.setData({ aiMessagesByZone: nextMessages, chatInput: '' }, () => this.refreshDerivedState(false))
    this.sendCommand('chat', { zoneId: zone.id, message: question })
  },

  requestPorts() {
    this.sendCommand('get_ports', {})
  },

  openSerial() {
    const port = this.data.ports[this.data.portIndex]
    if (!port || !port.path) {
      wx.showToast({ title: '请先选择串口', icon: 'none' })
      return
    }
    const baudRate = Number(this.data.baudRateInput) || 115200
    this.saveLocalConfig()
    this.sendCommand('serial_open', { path: port.path, baudRate })
  },

  closeSerial() {
    this.sendCommand('serial_close', {})
  },

  sendRawSerial() {
    const message = (this.data.sendInput || '').trim()
    if (!message) {
      wx.showToast({ title: '请输入串口消息', icon: 'none' })
      return
    }
    this.sendCommand('serial_send', {
      message,
      appendNewline: this.data.appendNewline,
      broadcast: this.data.broadcastMode,
    })
  },

  setMotorPreset(e) {
    const left = e.currentTarget.dataset.left
    const right = e.currentTarget.dataset.right
    this.setData({ motorLeft: String(left), motorRight: String(right) })
  },

  sendMotorCommand() {
    this.sendCommand('motor_command', {
      left: numberOrNull(this.data.motorLeft),
      right: numberOrNull(this.data.motorRight),
    })
  },

  stopMotor() {
    this.setData({ motorLeft: '0', motorRight: '0' })
    this.sendMotorCommand()
  },

  sendCalibration() {
    this.sendCommand('calibration', {
      ls: numberOrNull(this.data.calLeftScale),
      rs: numberOrNull(this.data.calRightScale),
      lo: numberOrNull(this.data.calLeftOffset),
      ro: numberOrNull(this.data.calRightOffset),
    })
  },

  openCreateZoneEditor() {
    const builtinSpeciesKeys = this.data.builtinSpeciesKeys || []
    const firstKey = builtinSpeciesKeys[0] || ''
    const firstSpecies = firstKey ? this.data.builtinSpecies[firstKey] : null
    const target = this.data.selectedTarget
    const zoneForm = createEmptyZoneForm()
    if (target) {
      zoneForm.latitude = String(target.latitude)
      zoneForm.longitude = String(target.longitude)
    }
    this.setData({
      zoneEditorVisible: true,
      zoneEditorMode: 'create',
      zoneForm,
      speciesModeIndex: 0,
      builtinSpeciesIndex: 0,
    }, () => {
      if (firstSpecies) this.applyBuiltinSpeciesToForm(0)
    })
  },

  openEditZoneEditor() {
    const zone = getSelectedZone(this.data.zones, this.data.selectedZoneId)
    if (!zone) {
      wx.showToast({ title: '请先选择区域', icon: 'none' })
      return
    }
    const profile = zone.speciesProfile || {}
    const thresholds = profile.thresholds || {}
    const zoneForm = {
      zoneId: zone.id,
      name: zone.name || '',
      speciesMode: profile.type || 'builtin',
      speciesKey: profile.key || '',
      customSpeciesName: profile.type === 'custom' ? (profile.label || '') : '',
      phMin: thresholds.phMin !== undefined ? String(thresholds.phMin) : '',
      phMax: thresholds.phMax !== undefined ? String(thresholds.phMax) : '',
      tempMin: thresholds.tempMin !== undefined ? String(thresholds.tempMin) : '',
      tempMax: thresholds.tempMax !== undefined ? String(thresholds.tempMax) : '',
      turbidityMax: thresholds.turbidityMax !== undefined ? String(thresholds.turbidityMax) : '',
      latitude: zone.geometry && zone.geometry.center ? String(zone.geometry.center.latitude) : '',
      longitude: zone.geometry && zone.geometry.center ? String(zone.geometry.center.longitude) : '',
      lengthM: zone.geometry && zone.geometry.lengthM !== undefined ? String(zone.geometry.lengthM) : '',
      widthM: zone.geometry && zone.geometry.widthM !== undefined ? String(zone.geometry.widthM) : '',
    }
    const speciesModeIndex = Math.max(0, SPECIES_MODES.findIndex((item) => item.value === zoneForm.speciesMode))
    const builtinSpeciesIndex = Math.max(0, this.data.builtinSpeciesKeys.indexOf(zoneForm.speciesKey))
    this.setData({
      zoneEditorVisible: true,
      zoneEditorMode: 'edit',
      zoneForm,
      speciesModeIndex,
      builtinSpeciesIndex,
    })
  },

  closeZoneEditor() {
    this.setData({ zoneEditorVisible: false })
  },

  saveZone() {
    const payload = buildZonePayload(this.data.zoneForm)
    if (this.data.zoneEditorMode === 'edit') {
      this.sendCommand('update_zone', payload)
    } else {
      this.sendCommand('create_zone', payload)
    }
    this.setData({ zoneEditorVisible: false })
  },

  deleteZone() {
    const zone = getSelectedZone(this.data.zones, this.data.selectedZoneId)
    if (!zone) {
      wx.showToast({ title: '请先选择区域', icon: 'none' })
      return
    }
    this.sendCommand('delete_zone', { zoneId: zone.id })
  },

  recoverZone() {
    const option = this.data.deletedZoneOptions[this.data.deletedZoneIndex]
    if (!option || !option.value) {
      wx.showToast({ title: '没有可恢复区域', icon: 'none' })
      return
    }
    this.sendCommand('recover_zone', { zoneId: option.value })
  },

  saveSamplingConfig() {
    const form = this.data.samplingForm || {}
    this.sendCommand('update_sampling_config', {
      arrivalRadiusM: numberOrNull(form.arrivalRadiusM),
      fallbackRadiusM: numberOrNull(form.fallbackRadiusM),
      fallbackAfterMs: numberOrNull(form.fallbackAfterMs),
      targetTimeoutMs: numberOrNull(form.targetTimeoutMs),
      stabilizationMs: numberOrNull(form.stabilizationMs),
      sampleIntervalMs: numberOrNull(form.sampleIntervalMs),
      sampleDurationMs: numberOrNull(form.sampleDurationMs),
    })
  },

  deleteSelectedSamples() {
    if (!this.data.selectedSampleIds.length) {
      wx.showToast({ title: '请先勾选样本', icon: 'none' })
      return
    }
    this.sendCommand('delete_samples', { ids: this.data.selectedSampleIds })
    this.setData({ selectedSampleIds: [] }, () => this.refreshDerivedState(false))
  },

  clearSelectedZoneSamples() {
    const zone = getSelectedZone(this.data.zones, this.data.selectedZoneId)
    if (!zone) {
      wx.showToast({ title: '请先选择区域', icon: 'none' })
      return
    }
    this.sendCommand('clear_zone_samples', { zoneId: zone.id })
  },

  saveLlmConfig() {
    const form = this.data.llmForm || {}
    this.sendCommand('update_llm_config', {
      provider: form.provider,
      cloudEndpoint: form.cloudEndpoint,
      cloudApiKey: form.cloudApiKey,
      cloudModel: form.cloudModel,
      ollamaEndpoint: form.ollamaEndpoint,
      ollamaModel: form.ollamaModel,
    })
  },

  goNetworkTest() {
    wx.navigateTo({ url: '/pages/network-test/network-test' })
  },
})
