const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');

const HTTP_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DEFAULT_BAUD_RATE = 115200;
const HISTORY_LIMIT = 200;
const LOG_LIMIT = 400;
const STATUS_SAMPLE_LIMIT = 500;

const DATA_DIR = path.join(__dirname, 'data');
const ZONES_FILE = path.join(DATA_DIR, 'zones.json');
const SAMPLES_FILE = path.join(DATA_DIR, 'samples.jsonl');

// 演示尺度默认值。原始值是"每点采样 1 小时 × 8 点 = 8 小时"，只适合真实生产作业，
// 演示和联调必须能在一轮内跑完，所以这里按"单点 30 秒"标定。
// 生产部署时在 WebUI「巡检任务 → 任务参数」里改回去即可。
const DEFAULT_SAMPLING_CONFIG = {
  arrivalRadiusM: 2,          // 到点判定，放宽以适应 GPS 静差
  fallbackRadiusM: 6,         // 保持/兜底半径
  boundaryMarginM: 4,         // 越界容差
  returnRadiusM: 8,           // 越界后归位触发半径
  fallbackAfterMs: 30 * 1000, // 进 6m 后 30 秒仍未进 2m 就降级接受
  targetTimeoutMs: 3 * 60 * 1000,
  stabilizationMs: 10 * 1000,
  sampleIntervalMs: 2 * 1000,
  sampleDurationMs: 30 * 1000,
};

// 采样点在区域矩形内的收缩比例（1.0 = 贴边界，0.65 = 向内缩 35% 半宽）。
// 原实现把 8 个点摆在矩形边上，GPS 静差 3~5m 时会频繁误判"越界归位"，
// 船在采样点附近来回抽搐、永远稳不下来。
const SAMPLE_POINT_INSET_RATIO = 0.65;

const BUILTIN_SPECIES = {
  grass_carp: {
    label: '草鱼',
    thresholds: { phMin: 6.5, phMax: 8.5, tempMin: 18, tempMax: 30, turbidityMax: 30 },
  },
  crucian_carp: {
    label: '鲫鱼',
    thresholds: { phMin: 6.5, phMax: 8.5, tempMin: 16, tempMax: 30, turbidityMax: 35 },
  },
  carp: {
    label: '鲤鱼',
    thresholds: { phMin: 6.5, phMax: 8.5, tempMin: 18, tempMax: 30, turbidityMax: 35 },
  },
  bass: {
    label: '鲈鱼',
    thresholds: { phMin: 7.0, phMax: 8.5, tempMin: 20, tempMax: 30, turbidityMax: 25 },
  },
  shrimp: {
    label: '虾',
    thresholds: { phMin: 7.5, phMax: 8.8, tempMin: 20, tempMax: 32, turbidityMax: 30 },
  },
  crab: {
    label: '蟹',
    thresholds: { phMin: 7.5, phMax: 8.8, tempMin: 20, tempMax: 30, turbidityMax: 30 },
  },
};

// --- LLM 风险分析配置 ---
// 通过环境变量或 data/llm-config.json 配置
// BOAT_LLM_PROVIDER: "cloud" | "ollama" | "anthropic" | "disabled"
// BOAT_LLM_API_KEY: 云端 OpenAI-compatible API key（不用于 Anthropic 兼容模式）
// BOAT_LLM_MODEL: 云端 OpenAI-compatible 模型名称
// BOAT_LLM_ENDPOINT: 云端 OpenAI-compatible API 端点
// Anthropic 兼容模式只读取后端环境变量：ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
const LLM_CONFIG_FILE = path.join(DATA_DIR, 'llm-config.json');
const ANTHROPIC_TIMEOUT_MS = 30000;

const DEFAULT_LLM_CONFIG = {
  provider: 'disabled',       // 'cloud' | 'ollama' | 'anthropic' | 'disabled'
  cloudEndpoint: 'https://api.deepseek.com/v1/chat/completions',
  cloudApiKey: '',
  cloudModel: 'deepseek-chat',
  ollamaEndpoint: 'http://localhost:11434/api/chat',
  ollamaModel: 'qwen2.5:7b',
  enabled: false,
};

let llmConfig = { ...DEFAULT_LLM_CONFIG };
const riskAnalysisCache = {};  // { zoneId: { result, timestamp } }
const RISK_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 分钟缓存

function getAnthropicToken() {
  return process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
}

function getAnthropicBaseUrl() {
  return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
}

function getAnthropicModel() {
  return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
    || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
    || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
    || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    || process.env.ANTHROPIC_MODEL
    || 'claude-sonnet-4-6';
}

function isAnthropicConfigured() {
  return Boolean(getAnthropicToken());
}

function refreshLlmEnabled() {
  llmConfig.enabled = llmConfig.provider !== 'disabled' && (
    (llmConfig.provider === 'cloud' && Boolean(llmConfig.cloudApiKey))
    || llmConfig.provider === 'ollama'
    || (llmConfig.provider === 'anthropic' && isAnthropicConfigured())
  );
}

function publicLlmConfig() {
  return {
    ...llmConfig,
    cloudApiKey: llmConfig.cloudApiKey ? '***' : '',
    anthropicConfigured: isAnthropicConfigured(),
    anthropicBaseUrlConfigured: Boolean(process.env.ANTHROPIC_BASE_URL),
    anthropicModel: getAnthropicModel(),
  };
}

function loadLlmConfig() {
  try {
    const fileConfig = readJsonFile(LLM_CONFIG_FILE, null);
    if (fileConfig) {
      llmConfig = { ...DEFAULT_LLM_CONFIG, ...fileConfig };
    }
    // 环境变量覆盖。Anthropic token 只读环境变量，不写入 llm-config.json。
    if (process.env.BOAT_LLM_PROVIDER) llmConfig.provider = process.env.BOAT_LLM_PROVIDER;
    else if (isAnthropicConfigured() && llmConfig.provider === 'disabled') llmConfig.provider = 'anthropic';
    if (process.env.BOAT_LLM_API_KEY) llmConfig.cloudApiKey = process.env.BOAT_LLM_API_KEY;
    if (process.env.BOAT_LLM_MODEL) llmConfig.cloudModel = process.env.BOAT_LLM_MODEL;
    if (process.env.BOAT_LLM_ENDPOINT) llmConfig.cloudEndpoint = process.env.BOAT_LLM_ENDPOINT;
    refreshLlmEnabled();
  } catch (error) {
    console.warn(`加载 LLM 配置失败: ${error.message}`);
  }
}

function saveLlmConfig() {
  writeJsonFileAtomic(LLM_CONFIG_FILE, llmConfig);
}

function edgeAiTrust(sample) {
  const edgeAi = sample?.edgeAi || {};
  return {
    phTrusted: edgeAi.phNormal === null || edgeAi.phNormal === undefined ? null : Boolean(edgeAi.phNormal),
    temperatureTrusted: edgeAi.temperatureNormal === null || edgeAi.temperatureNormal === undefined ? null : Boolean(edgeAi.temperatureNormal),
  };
}

function edgeAiTrustLines(sample) {
  const trust = edgeAiTrust(sample);
  const phText = trust.phTrusted === null ? '无边缘 AI 校验数据' : trust.phTrusted ? '可信' : '异常，建议复测或校准 pH 探头';
  const temperatureText = trust.temperatureTrusted === null ? '无边缘 AI 校验数据' : trust.temperatureTrusted ? '可信' : '异常，建议复测或检查温度传感器';
  return `- pH 数据可信状态：${phText}\n- 水温数据可信状态：${temperatureText}`;
}

function edgeAiWarningText(sample) {
  const trust = edgeAiTrust(sample);
  const warnings = [];
  if (trust.phTrusted === false) warnings.push('pH 数据被边缘 AI 判为异常，请不要基于该 pH 值给出强结论，应优先建议复测或校准 pH 探头');
  if (trust.temperatureTrusted === false) warnings.push('水温数据被边缘 AI 判为异常，请不要基于该水温值给出强结论，应优先建议复测或检查温度传感器');
  return warnings.length ? `【边缘 AI 注意】\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : '';
}

function buildRiskPrompt(zone, sample, weatherHint) {
  const thresholds = zone.speciesProfile?.thresholds || {};
  const water = sample?.water || {};
  return `你是水产养殖风险分析专家。请根据以下信息分析该养殖区域的风险状况，并给出面向养殖户的建议。

【区域信息】
- 区域名称：${zone.name}
- 养殖对象：${zone.speciesProfile?.label || '未配置'}

【当前水质数据】
- pH：${water.ph ?? '无数据'}
- 水温：${water.tempC !== null && water.tempC !== undefined ? water.tempC + '℃' : '无数据'}
- 浊度：${water.turbidity !== null && water.turbidity !== undefined ? water.turbidity + ' NTU' : '无数据'}

【边缘 AI 数据可信校验】
${edgeAiTrustLines(sample)}

【适宜范围参考】
- pH：${thresholds.phMin ?? '?'} ~ ${thresholds.phMax ?? '?'}
- 水温：${thresholds.tempMin ?? '?'} ~ ${thresholds.tempMax ?? '?'}℃
- 浊度上限：${thresholds.turbidityMax ?? '?'} NTU

${weatherHint ? `【天气/外部风险】\n${weatherHint}\n` : ''}
${!sample ? '【注意】该区域暂无采样数据，请基于一般养殖经验给出参考建议。\n' : ''}
${sample && sample.source !== 'serial' ? `【注意】当前数据来源为${sample.source === 'manual' ? '手动采样（未校验）' : '测试数据'}，仅供参考。\n` : ''}
${edgeAiWarningText(sample)}
请用以下 JSON 格式回复，不要有其他内容：
{"level":"normal|warning|danger|unknown","summary":"一句话总结","reasons":["原因1","原因2"],"suggestions":["建议1","建议2"],"confidence":"high|medium|low"}`;
}

async function callCloudLLM(prompt) {
  const response = await fetch(llmConfig.cloudEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${llmConfig.cloudApiKey}`,
    },
    body: JSON.stringify({
      model: llmConfig.cloudModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`云端 LLM 请求失败: ${response.status} ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  return content;
}

async function callOllamaLLM(prompt) {
  const response = await fetch(llmConfig.ollamaEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: llmConfig.ollamaModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: 0.3 },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Ollama 请求失败: ${response.status} ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.message?.content || '';
}

async function callAnthropicLLM(prompt, options = {}) {
  const token = getAnthropicToken();
  if (!token) {
    throw new Error('Anthropic 兼容模式未配置后端环境变量');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || ANTHROPIC_TIMEOUT_MS);
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
    if (!process.env.BOAT_ANTHROPIC_SKIP_OAUTH_BETA) {
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    }
  } else {
    headers['x-api-key'] = token;
  }

  try {
    const response = await fetch(`${getAnthropicBaseUrl()}/v1/messages`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: getAnthropicModel(),
        max_tokens: Math.max(128, Math.min(Number(options.maxTokens) || 900, 1600)),
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Anthropic 请求失败: ${response.status} ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    if (data.stop_reason === 'refusal') {
      throw new Error('Anthropic 拒绝了本次分析请求');
    }

    return Array.isArray(data.content)
      ? data.content.filter((block) => block.type === 'text').map((block) => block.text || '').join('\n').trim()
      : '';
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Anthropic 请求超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function callConfiguredLLM(prompt, options = {}) {
  if (llmConfig.provider === 'anthropic') return callAnthropicLLM(prompt, options);
  if (llmConfig.provider === 'cloud') return callCloudLLM(prompt);
  if (llmConfig.provider === 'ollama') return callOllamaLLM(prompt);
  throw new Error('LLM 未启用');
}

function parseLlmResponse(content) {
  // 尝试从回复中提取 JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    const result = JSON.parse(jsonMatch[0]);
    if (!result.level || !result.summary) {
      return null;
    }
    return {
      level: ['normal', 'warning', 'danger', 'unknown'].includes(result.level) ? result.level : 'unknown',
      summary: String(result.summary).slice(0, 200),
      reasons: Array.isArray(result.reasons) ? result.reasons.slice(0, 5).map(String) : [],
      suggestions: Array.isArray(result.suggestions) ? result.suggestions.slice(0, 5).map(String) : [],
      confidence: ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'low',
    };
  } catch {
    return null;
  }
}

function getRuleBasedRisk(zone, sample) {
  if (!sample) {
    return { level: 'unknown', summary: '暂无采样数据', reasons: [], suggestions: ['请先对该区域进行采样'], confidence: 'low' };
  }
  const thresholds = zone.speciesProfile?.thresholds;
  if (!thresholds) {
    return { level: 'unknown', summary: '未配置养殖对象阈值', reasons: [], suggestions: ['请先配置该区域的养殖对象'], confidence: 'low' };
  }
  const w = sample.water || {};
  const trust = edgeAiTrust(sample);
  const reasons = [];
  const suggestions = [];
  let level = 'normal';
  if (trust.phTrusted === false) {
    reasons.push('边缘 AI 判断 pH 数据异常，建议复测或校准 pH 探头');
    suggestions.push('先重新采集 pH 数据，必要时用标准液校准 pH 探头');
    level = 'warning';
  } else if (w.ph !== null && w.ph !== undefined) {
    if (w.ph < thresholds.phMin || w.ph > thresholds.phMax) { reasons.push(`pH=${w.ph} 超出适宜范围 ${thresholds.phMin}~${thresholds.phMax}`); level = 'danger'; }
    else if (w.ph < thresholds.phMin + 0.2 || w.ph > thresholds.phMax - 0.2) { reasons.push(`pH=${w.ph} 接近适宜范围边界`); if (level === 'normal') level = 'warning'; }
  }
  if (trust.temperatureTrusted === false) {
    reasons.push('边缘 AI 判断水温数据异常，建议复测或检查温度传感器');
    suggestions.push('先重新采集水温数据，检查 DS18B20 接线和探头入水状态');
    if (level === 'normal') level = 'warning';
  } else if (w.tempC !== null && w.tempC !== undefined) {
    if (w.tempC < thresholds.tempMin || w.tempC > thresholds.tempMax) { reasons.push(`水温=${w.tempC}℃ 超出适宜范围 ${thresholds.tempMin}~${thresholds.tempMax}℃`); level = 'danger'; }
    else if (w.tempC < thresholds.tempMin + 1 || w.tempC > thresholds.tempMax - 1) { reasons.push(`水温=${w.tempC}℃ 接近适宜范围边界`); if (level === 'normal') level = 'warning'; }
  }
  if (w.turbidity !== null && w.turbidity !== undefined) {
    if (w.turbidity > thresholds.turbidityMax * 1.25) { reasons.push(`浊度=${w.turbidity}NTU 严重超出上限 ${thresholds.turbidityMax}NTU`); level = 'danger'; }
    else if (w.turbidity > thresholds.turbidityMax) { reasons.push(`浊度=${w.turbidity}NTU 超出上限 ${thresholds.turbidityMax}NTU`); if (level === 'normal') level = 'warning'; }
  }
  const summary = level === 'normal' ? '当前水质处于适宜范围' : level === 'warning' ? '部分指标需复测或接近边界' : '关键指标超出适宜范围，需处理';
  return { level, summary, reasons, suggestions, confidence: suggestions.length ? 'low' : 'medium' };
}

async function analyzeZoneRisk(zoneId, weatherHint) {
  const zone = getZoneById(zoneId);
  if (!zone) throw new Error('区域不存在');
  const sample = state.latestSampleByZone[zoneId] || null;

  // 检查缓存
  const cached = riskAnalysisCache[zoneId];
  if (cached && Date.now() - cached.timestamp < RISK_CACHE_TTL_MS) {
    return cached.result;
  }

  let result;
  if (llmConfig.enabled) {
    try {
      const prompt = buildRiskPrompt(zone, sample, weatherHint);
      const content = await callConfiguredLLM(prompt, { maxTokens: 700 });
      const parsed = parseLlmResponse(content);
      if (parsed) {
        result = { ...parsed, source: llmConfig.provider === 'anthropic' ? 'anthropic' : 'llm', analyzedAt: nowIso() };
      } else {
        console.warn('LLM 返回内容解析失败，使用规则兜底');
        result = { ...getRuleBasedRisk(zone, sample), source: 'rule_fallback', analyzedAt: nowIso() };
      }
    } catch (error) {
      console.warn(`LLM 分析失败: ${error.message}，使用规则兜底`);
      result = { ...getRuleBasedRisk(zone, sample), source: 'rule_fallback', analyzedAt: nowIso() };
    }
  } else {
    result = { ...getRuleBasedRisk(zone, sample), source: 'rule', analyzedAt: nowIso() };
  }

  riskAnalysisCache[zoneId] = { result, timestamp: Date.now() };
  return result;
}

function buildRuleFallbackReply(zone, sample, rule, question) {
  const suggestions = rule.suggestions?.length ? rule.suggestions : ['建议先复测该区域，确认传感器数据稳定后再做投喂或换水决策'];
  const reasons = rule.reasons?.length ? `主要原因：${rule.reasons.join('；')}。` : '当前没有明显超限原因，仍建议结合连续采样趋势判断。';
  const dataNote = sample ? `最新数据：pH ${sample.water?.ph ?? '无'}，水温 ${sample.water?.tempC ?? '无'}℃，浊度 ${sample.water?.turbidity ?? '无'} NTU。` : '该区域暂无有效采样数据。';
  const edgeWarning = edgeAiWarningText(sample).replace('【边缘 AI 注意】\n', '').replace(/\n/g, '；');
  const edgeNote = edgeWarning ? `边缘 AI 提示：${edgeWarning}` : '';
  return `【规则兜底建议】${zone.name}（${zone.speciesProfile?.label || '未配置养殖对象'}）当前判断为“${rule.summary}”。${dataNote}${edgeNote}${reasons}针对“${question || '当前区域建议'}”，建议：${suggestions.join('；')}。`;
}

function buildAnalysisChatPrompt(zone, sample, rule, question) {
  const thresholds = zone.speciesProfile?.thresholds || {};
  const water = sample?.water || {};
  const latest = state.latestData || {};
  const task = state.sampling?.task;
  return `你是水产养殖巡检系统的 AI 助手，面向普通养殖户给出简洁、可执行的建议。请只基于下面的数据分析，不要编造没有提供的传感器读数。

【用户问题】
${question || '请分析该区域当前水质并给出养殖建议'}

【区域】
- 名称：${zone.name}
- 养殖对象：${zone.speciesProfile?.label || '未配置'}
- 阈值：pH ${thresholds.phMin ?? '?'}~${thresholds.phMax ?? '?'}，水温 ${thresholds.tempMin ?? '?'}~${thresholds.tempMax ?? '?'}℃，浊度上限 ${thresholds.turbidityMax ?? '?'} NTU

【该区域最新采样】
- pH：${water.ph ?? '无数据'}
- 水温：${water.tempC != null ? `${water.tempC}℃` : '无数据'}
- 浊度：${water.turbidity != null ? `${water.turbidity} NTU` : '无数据'}
- 来源：${sample?.source || '无'}
- 时间：${sample?.savedAt || sample?.receivedAt || '无'}

【边缘 AI 数据可信校验】
${edgeAiTrustLines(sample)}
${edgeAiWarningText(sample)}

【小船最新遥测】
- GPS：${Number(latest.fix) > 0 ? '已定位' : '未定位'}，卫星 ${latest.sat ?? '无'}
- IMU：${Number(latest.iv) === 1 ? '有效' : '无效'}
- 导航状态：${latest.ns ?? '无'}

【规则基线】
- 风险：${rule.level}
- 总结：${rule.summary}
- 原因：${rule.reasons?.join('；') || '无'}

【巡检任务】
${task && task.zoneId === zone.id ? `当前处于 ${task.phase}，采样点 ${(task.currentPointIndex || 0) + 1}/${task.samplePoints?.length || 0}` : '当前没有该区域的巡检任务'}

请用中文回答，最多 4 点：1）当前判断；2）是否建议投喂/换水/复测；3）下一步操作；4）如果数据不足请明确说明。语气专业但不要冗长。`;
}

async function analyzeZoneChat(zoneId, question) {
  const zone = getZoneById(zoneId);
  if (!zone) {
    const error = new Error('区域不存在');
    error.statusCode = 404;
    throw error;
  }

  const sample = state.latestSampleByZone[zoneId] || null;
  const rule = getRuleBasedRisk(zone, sample);
  const safeQuestion = String(question || '').trim().slice(0, 500) || '请分析该区域当前水质并给出养殖建议';

  if (!llmConfig.enabled) {
    return {
      reply: buildRuleFallbackReply(zone, sample, rule, safeQuestion),
      source: 'rule',
      model: null,
      analyzedAt: nowIso(),
    };
  }

  try {
    const prompt = buildAnalysisChatPrompt(zone, sample, rule, safeQuestion);
    const reply = await callConfiguredLLM(prompt, { maxTokens: 900 });
    if (!reply) throw new Error('LLM 返回空内容');
    return {
      reply: reply.slice(0, 1200),
      source: llmConfig.provider === 'anthropic' ? 'anthropic' : 'llm',
      model: llmConfig.provider === 'anthropic' ? getAnthropicModel() : (llmConfig.provider === 'ollama' ? llmConfig.ollamaModel : llmConfig.cloudModel),
      analyzedAt: nowIso(),
    };
  } catch (error) {
    console.warn(`AI 对话分析失败: ${error.message}，使用规则兜底`);
    return {
      reply: buildRuleFallbackReply(zone, sample, rule, safeQuestion),
      source: 'rule_fallback',
      model: null,
      analyzedAt: nowIso(),
    };
  }
}

loadLlmConfig();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json({ limit: '1mb' }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));
app.use(express.static(path.join(__dirname, 'public')));

let activePort = null;
let activeBaudRate = DEFAULT_BAUD_RATE;
let lineBuffer = Buffer.alloc(0);
let gpsTestPort = null;
let gpsTestBaudRate = 38400;
let gpsTestLineBuffer = Buffer.alloc(0);
let entryId = 0;

const gpsTestState = {
  latest: null,
  lastSentenceAt: null,
  sentenceCount: 0,
  byteCount: 0,
  checksumErrors: 0,
  lines: [],
  track: [],
};

const state = {
  latestBoot: null,
  latestData: null,
  latestDataReceivedAt: null,
  history: [],
  logs: [],
  lastMessageAt: null,
  zones: [],
  samples: [],
  latestSampleByZone: {},
  sampling: {
    status: 'idle',
    task: null,
    warning: null,
    config: { ...DEFAULT_SAMPLING_CONFIG },
  },
};

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return `${prefix}_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

function getSerialStatus() {
  return {
    connected: Boolean(activePort && activePort.isOpen),
    portPath: activePort ? activePort.path : null,
    baudRate: activePort ? activeBaudRate : null,
    partialBytes: lineBuffer.length,
    lastMessageAt: state.lastMessageAt,
  };
}

function getGpsTestStatus() {
  return {
    connected: Boolean(gpsTestPort && gpsTestPort.isOpen),
    portPath: gpsTestPort ? gpsTestPort.path : null,
    baudRate: gpsTestPort ? gpsTestBaudRate : null,
    partialBytes: gpsTestLineBuffer.length,
    lastSentenceAt: gpsTestState.lastSentenceAt,
    sentenceCount: gpsTestState.sentenceCount,
    byteCount: gpsTestState.byteCount,
    checksumErrors: gpsTestState.checksumErrors,
    latest: gpsTestState.latest,
    lines: gpsTestState.lines,
    track: gpsTestState.track,
  };
}

function nmeaChecksumValid(line) {
  const starIndex = line.indexOf('*');
  if (!line.startsWith('$') || starIndex < 0 || starIndex + 2 >= line.length) return null;
  let checksum = 0;
  for (let index = 1; index < starIndex; index += 1) checksum ^= line.charCodeAt(index);
  const expected = Number.parseInt(line.slice(starIndex + 1, starIndex + 3), 16);
  return Number.isFinite(expected) ? checksum === expected : false;
}

function nmeaCoordinate(value, hemisphere) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || !hemisphere) return null;
  const degrees = Math.floor(raw / 100);
  const minutes = raw - degrees * 100;
  const coordinate = degrees + minutes / 60;
  return ['S', 'W'].includes(String(hemisphere).toUpperCase()) ? -coordinate : coordinate;
}

function nmeaUtc(value) {
  const text = String(value || '');
  if (text.length < 6) return null;
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(2, 4));
  const second = Number(text.slice(4));
  return [hour, minute, second].every(Number.isFinite)
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${second.toFixed(2).padStart(5, '0')} UTC`
    : null;
}

function parseNmeaSentence(line) {
  const body = line.startsWith('$') ? line.slice(1, line.indexOf('*') >= 0 ? line.indexOf('*') : undefined) : line;
  const fields = body.split(',');
  const identifier = fields[0] || '';
  const type = identifier.slice(-3).toUpperCase();
  const checksumValid = nmeaChecksumValid(line);
  const parsed = { type, talker: identifier.slice(0, -3), checksumValid, raw: line };

  if (type === 'GGA') {
    parsed.utc = nmeaUtc(fields[1]);
    parsed.latitude = nmeaCoordinate(fields[2], fields[3]);
    parsed.longitude = nmeaCoordinate(fields[4], fields[5]);
    parsed.fix = Number(fields[6]) || 0;
    parsed.satellites = Number(fields[7]) || 0;
    parsed.hdop = fields[8] === '' ? null : Number(fields[8]);
    parsed.altitudeM = fields[9] === '' ? null : Number(fields[9]);
  } else if (type === 'RMC') {
    parsed.utc = nmeaUtc(fields[1]);
    parsed.valid = fields[2] === 'A';
    parsed.latitude = nmeaCoordinate(fields[3], fields[4]);
    parsed.longitude = nmeaCoordinate(fields[5], fields[6]);
    parsed.speedKph = fields[7] === '' ? null : Number(fields[7]) * 1.852;
    parsed.course = fields[8] === '' ? null : Number(fields[8]);
    parsed.date = fields[9] || null;
    parsed.mode = fields[12] || null;
  }

  return parsed;
}

function applyGpsTestSentence(parsed, receivedAt) {
  const previous = gpsTestState.latest || {};
  const latest = { ...previous, sentenceType: parsed.type, talker: parsed.talker, checksumValid: parsed.checksumValid, receivedAt, raw: parsed.raw };
  if (parsed.utc != null) latest.utc = parsed.utc;
  if (parsed.type === 'GGA') {
    latest.fix = parsed.fix;
    latest.satellites = parsed.satellites;
    latest.hdop = parsed.hdop;
    latest.altitudeM = parsed.altitudeM;
  } else if (parsed.type === 'RMC') {
    latest.valid = parsed.valid;
    latest.speedKph = parsed.speedKph;
    latest.course = parsed.course;
    latest.date = parsed.date;
    latest.mode = parsed.mode;
    if (parsed.valid) latest.fix = Math.max(1, Number(latest.fix) || 0);
    else if (latest.fix == null) latest.fix = 0;
  }
  if (parsed.latitude != null && parsed.longitude != null) {
    latest.latitude = parsed.latitude;
    latest.longitude = parsed.longitude;
    const positioned = parsed.type === 'GGA' ? parsed.fix > 0 : parsed.type === 'RMC' ? parsed.valid : false;
    if (positioned) {
      const lastPoint = gpsTestState.track[gpsTestState.track.length - 1];
      if (!lastPoint || lastPoint.latitude !== parsed.latitude || lastPoint.longitude !== parsed.longitude) {
        gpsTestState.track.push({ latitude: parsed.latitude, longitude: parsed.longitude, receivedAt });
        if (gpsTestState.track.length > 500) gpsTestState.track.splice(0, gpsTestState.track.length - 500);
      }
    }
  }
  gpsTestState.latest = latest;
}

function handleGpsTestLine(line) {
  const text = cleanLineBuffer(line);
  if (!text) return;
  const receivedAt = nowIso();
  const parsed = parseNmeaSentence(text);
  const previousTrackLength = gpsTestState.track.length;
  gpsTestState.lastSentenceAt = receivedAt;
  gpsTestState.sentenceCount += 1;
  if (parsed.checksumValid === false) gpsTestState.checksumErrors += 1;
  const lineEntry = { text, receivedAt, type: parsed.type || 'TEXT', checksumValid: parsed.checksumValid };
  gpsTestState.lines.unshift(lineEntry);
  if (gpsTestState.lines.length > 200) gpsTestState.lines.length = 200;
  applyGpsTestSentence(parsed, receivedAt);
  const { lines, track, ...summary } = getGpsTestStatus();
  broadcast({ kind: 'gps-test-message', gpsTest: summary, line: lineEntry, point: gpsTestState.track.length > previousTrackLength ? gpsTestState.track[gpsTestState.track.length - 1] : null });
}

function handleGpsTestChunk(chunk) {
  gpsTestState.byteCount += chunk.length;
  gpsTestLineBuffer = Buffer.concat([gpsTestLineBuffer, chunk]);
  while (true) {
    const lineFeedIndex = gpsTestLineBuffer.indexOf(0x0a);
    if (lineFeedIndex === -1) break;
    let line = gpsTestLineBuffer.subarray(0, lineFeedIndex);
    gpsTestLineBuffer = gpsTestLineBuffer.subarray(lineFeedIndex + 1);
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    handleGpsTestLine(line);
  }
  if (gpsTestLineBuffer.length > 4096) gpsTestLineBuffer = gpsTestLineBuffer.subarray(-4096);
}

function resetGpsTestPortState() {
  gpsTestPort = null;
  gpsTestBaudRate = 38400;
  gpsTestLineBuffer = Buffer.alloc(0);
}

function closeGpsTestPort() {
  return new Promise((resolve, reject) => {
    if (!gpsTestPort || !gpsTestPort.isOpen) {
      resetGpsTestPortState();
      resolve();
      return;
    }
    gpsTestPort.close((error) => error ? reject(error) : resolve());
  });
}

function bindGpsTestPortEvents(port) {
  port.on('data', (chunk) => { if (port === gpsTestPort) handleGpsTestChunk(chunk); });
  port.on('error', (error) => {
    if (port !== gpsTestPort) return;
    broadcast({ kind: 'gps-test-error', gpsTest: getGpsTestStatus(), message: error.message || String(error) });
  });
  port.on('close', () => {
    if (port !== gpsTestPort) return;
    resetGpsTestPortState();
    broadcast({ kind: 'gps-test-status', gpsTest: getGpsTestStatus() });
  });
}

function pushLimited(list, item, limit) {
  list.unshift(item);
  if (list.length > limit) {
    list.length = limit;
  }
}

function broadcast(payload) {
  const message = JSON.stringify(payload);

  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

function numberOrDash(value) {
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

function scaleValue(value, divisor, digits = 2) {
  if (value === undefined || value === null) {
    return '-';
  }

  return (Number(value) / divisor).toFixed(digits);
}

function scaledNumber(value, divisor, digits = 2) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }

  return Number((numberValue / divisor).toFixed(digits));
}

function formatFix(value) {
  return Number(value) > 0 ? `已定位 (${value})` : '未定位';
}

function formatLatLon(rawValue) {
  if (rawValue === undefined || rawValue === null || Number(rawValue) === 0) {
    return '-';
  }

  return (Number(rawValue) / 10000000).toFixed(7);
}

function rawToCoordinate(rawValue) {
  if (rawValue === undefined || rawValue === null || Number(rawValue) === 0) {
    return null;
  }

  const coordinate = Number(rawValue) / 10000000;
  return Number.isFinite(coordinate) ? coordinate : null;
}

function summarizeMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return '未识别消息';
  }

  if (payload.t === 'boot') {
    const divider = payload.div !== undefined
      ? numberOrDash(payload.div)
      : `pH ${scaleValue(payload.phdiv, 100)} / 浊 ${scaleValue(payload.tbdiv, 100)}`;
    return `启动: ${payload.msg || 'boat telemetry start'} / 分压倍率=${divider}`;
  }

  if (payload.t === 'data') {
    const ph = scaleValue(payload.ph, 100);
    const temp = Number(payload.tv) === 1 ? `${scaleValue(payload.tc, 100)}℃` : '无效';
    const gps = Number(payload.fix) > 0
      ? `${formatLatLon(payload.lat)}, ${formatLatLon(payload.lon)}`
      : '未定位';

    return `seq=${numberOrDash(payload.seq)} / pH=${ph} / 温度=${temp} / GPS=${gps}`;
  }

  return `JSON 消息: ${payload.t || 'unknown'}`;
}

function addLog(direction, text) {
  const log = {
    id: ++entryId,
    direction,
    text,
    timestamp: nowIso(),
  };

  pushLimited(state.logs, log, LOG_LIMIT);
  return log;
}

function addHistory(type, raw, payload) {
  const entry = {
    id: ++entryId,
    timestamp: nowIso(),
    type,
    seq: payload && payload.seq !== undefined ? payload.seq : '',
    summary: payload ? summarizeMessage(payload) : raw,
    raw,
    payload,
  };

  pushLimited(state.history, entry, HISTORY_LIMIT);
  return entry;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) {
      return fallback;
    }

    return JSON.parse(content);
  } catch (error) {
    console.warn(`读取 JSON 文件失败 ${filePath}: ${error.message}`);
    return fallback;
  }
}

function writeTextFileAtomic(filePath, content) {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, content, 'utf8');
  fs.renameSync(tempFile, filePath);
}

function writeJsonFileAtomic(filePath, value) {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) {
      return [];
    }

    const rows = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        rows.push(JSON.parse(trimmed));
      } catch (error) {
        console.warn(`跳过损坏的 samples.jsonl 第 ${index + 1} 行: ${error.message}`);
      }
    }

    return rows;
  } catch (error) {
    console.warn(`读取 JSONL 文件失败 ${filePath}: ${error.message}`);
    return [];
  }
}

function appendJsonLine(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function saveZonesFile() {
  writeJsonFileAtomic(ZONES_FILE, {
    version: 1,
    samplingConfig: state.sampling.config,
    zones: state.zones,
  });
}

function rewriteSamplesFile() {
  const chronological = state.samples.slice().reverse();
  const content = chronological.map((sample) => JSON.stringify(sample)).join('\n');
  writeTextFileAtomic(SAMPLES_FILE, content ? `${content}\n` : '');
}

function cloneThresholds(thresholds) {
  return {
    phMin: Number(thresholds.phMin),
    phMax: Number(thresholds.phMax),
    tempMin: Number(thresholds.tempMin),
    tempMax: Number(thresholds.tempMax),
    turbidityMax: Number(thresholds.turbidityMax),
  };
}

function seedZones() {
  const createdAt = nowIso();
  const seeds = [
    ['zone_A', 'A区 草鱼塘', 'grass_carp', 34.5001, 104.0001],
    ['zone_B', 'B区 鲫鱼塘', 'crucian_carp', 34.5003, 104.0003],
    ['zone_C', 'C区 鲤鱼塘', 'carp', 34.5005, 104.0005],
    ['zone_D', 'D区 鲈鱼塘', 'bass', 34.5007, 104.0007],
    ['zone_E', 'E区 虾塘', 'shrimp', 34.5009, 104.0009],
  ];

  return seeds.map(([id, name, speciesKey, latitude, longitude]) => {
    const species = BUILTIN_SPECIES[speciesKey];
    return {
      id,
      name,
      speciesProfile: {
        type: 'builtin',
        key: speciesKey,
        label: species.label,
        thresholds: cloneThresholds(species.thresholds),
      },
      geometry: {
        type: 'axis_aligned_rectangle',
        center: { latitude, longitude },
        lengthM: 20,
        widthM: 10,
      },
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
  });
}

function initializeStorage() {
  ensureDataDir();

  const zonesDoc = readJsonFile(ZONES_FILE, null);
  if (zonesDoc && Array.isArray(zonesDoc.zones)) {
    state.zones = zonesDoc.zones;
    try {
      state.sampling.config = normalizeSamplingConfig({
        ...DEFAULT_SAMPLING_CONFIG,
        ...(zonesDoc.samplingConfig || {}),
      });
    } catch (error) {
      console.warn(`采样配置无效，已恢复默认值: ${error.message}`);
      state.sampling.config = { ...DEFAULT_SAMPLING_CONFIG };
      saveZonesFile();
    }
  } else {
    state.zones = seedZones();
    state.sampling.config = { ...DEFAULT_SAMPLING_CONFIG };
    saveZonesFile();
  }

  state.samples = readJsonLines(SAMPLES_FILE).reverse();
  rebuildLatestSampleByZone();
}

function visibleZones(includeDeleted = false) {
  return includeDeleted ? state.zones : state.zones.filter((zone) => !zone.deletedAt);
}

function visibleSamples(includeDeleted = false) {
  return includeDeleted ? state.samples : state.samples.filter((sample) => !sample.deletedAt);
}

function rebuildLatestSampleByZone() {
  const latest = {};
  for (const sample of state.samples) {
    if (sample.deletedAt || !sample.zoneId || latest[sample.zoneId]) {
      continue;
    }

    latest[sample.zoneId] = sample;
  }

  state.latestSampleByZone = latest;
}

function getZoneById(zoneId, options = {}) {
  return state.zones.find((zone) => zone.id === zoneId && (options.includeDeleted || !zone.deletedAt)) || null;
}

function requireString(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    const error = new Error(`${label}不能为空`);
    error.statusCode = 400;
    throw error;
  }

  return text;
}

function requireFiniteNumber(value, label) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    const error = new Error(`${label}必须是数字`);
    error.statusCode = 400;
    throw error;
  }

  return numberValue;
}

function normalizeThresholds(input) {
  const thresholds = {
    phMin: requireFiniteNumber(input && input.phMin, 'pH 下限'),
    phMax: requireFiniteNumber(input && input.phMax, 'pH 上限'),
    tempMin: requireFiniteNumber(input && input.tempMin, '水温下限'),
    tempMax: requireFiniteNumber(input && input.tempMax, '水温上限'),
    turbidityMax: requireFiniteNumber(input && input.turbidityMax, '浊度上限'),
  };

  if (thresholds.phMin >= thresholds.phMax) {
    const error = new Error('pH 下限必须小于上限');
    error.statusCode = 400;
    throw error;
  }

  if (thresholds.tempMin >= thresholds.tempMax) {
    const error = new Error('水温下限必须小于上限');
    error.statusCode = 400;
    throw error;
  }

  if (thresholds.turbidityMax < 0) {
    const error = new Error('浊度上限不能小于 0');
    error.statusCode = 400;
    throw error;
  }

  return thresholds;
}

function normalizeSpeciesProfile(body) {
  const profile = body.speciesProfile || {};
  const mode = body.speciesMode || profile.type || 'builtin';

  if (mode === 'builtin') {
    const key = body.speciesKey || profile.key;
    const species = BUILTIN_SPECIES[key];
    if (!species) {
      const error = new Error('请选择有效的内置养殖对象');
      error.statusCode = 400;
      throw error;
    }

    return {
      type: 'builtin',
      key,
      label: species.label,
      thresholds: cloneThresholds(species.thresholds),
    };
  }

  if (mode === 'custom') {
    const label = requireString(body.customSpeciesName || profile.label, '自定义养殖对象名称');
    return {
      type: 'custom',
      key: null,
      label,
      thresholds: normalizeThresholds(body.thresholds || profile.thresholds || {}),
    };
  }

  const error = new Error('未知养殖对象类型');
  error.statusCode = 400;
  throw error;
}

function normalizeGeometry(body) {
  const geometry = body.geometry || {};
  const center = body.center || geometry.center || {};
  const latitude = requireFiniteNumber(center.latitude, '中心纬度');
  const longitude = requireFiniteNumber(center.longitude, '中心经度');
  const lengthM = requireFiniteNumber(body.lengthM !== undefined ? body.lengthM : geometry.lengthM, '长度');
  const widthM = requireFiniteNumber(body.widthM !== undefined ? body.widthM : geometry.widthM, '宽度');

  if (latitude < -90 || latitude > 90) {
    const error = new Error('中心纬度必须在 -90 到 90 之间');
    error.statusCode = 400;
    throw error;
  }

  if (longitude < -180 || longitude > 180) {
    const error = new Error('中心经度必须在 -180 到 180 之间');
    error.statusCode = 400;
    throw error;
  }

  if (lengthM <= 0 || widthM <= 0) {
    const error = new Error('长度和宽度必须大于 0');
    error.statusCode = 400;
    throw error;
  }

  return {
    type: 'axis_aligned_rectangle',
    center: { latitude, longitude },
    lengthM,
    widthM,
  };
}

function normalizeZoneInput(body, existingZone = null) {
  const now = nowIso();
  return {
    id: existingZone ? existingZone.id : makeId('zone'),
    name: requireString(body.name, '区域名称'),
    speciesProfile: normalizeSpeciesProfile(body),
    geometry: normalizeGeometry(body),
    deletedAt: existingZone ? existingZone.deletedAt : null,
    createdAt: existingZone ? existingZone.createdAt : now,
    updatedAt: now,
  };
}

function normalizeSamplingConfig(input) {
  const config = {
    arrivalRadiusM: Number(input.arrivalRadiusM),
    fallbackRadiusM: Number(input.fallbackRadiusM),
    boundaryMarginM: Number(input.boundaryMarginM),
    returnRadiusM: Number(input.returnRadiusM),
    fallbackAfterMs: Number(input.fallbackAfterMs),
    targetTimeoutMs: Number(input.targetTimeoutMs),
    stabilizationMs: Number(input.stabilizationMs),
    sampleIntervalMs: Number(input.sampleIntervalMs),
    sampleDurationMs: Number(input.sampleDurationMs),
  };

  for (const [key, value] of Object.entries(config)) {
    const invalid = key === 'boundaryMarginM' ? (!Number.isFinite(value) || value < 0) : (!Number.isFinite(value) || value <= 0);
    if (invalid) {
      const error = new Error(key === 'boundaryMarginM' ? `${key} 不能小于 0` : `${key} 必须是大于 0 的数字`);
      error.statusCode = 400;
      throw error;
    }
  }

  if (config.arrivalRadiusM > config.fallbackRadiusM) {
    const error = new Error('中心到达半径不能大于兜底/保持半径');
    error.statusCode = 400;
    throw error;
  }

  if (config.sampleIntervalMs < 1000) {
    const error = new Error('采样间隔不能小于 1 秒');
    error.statusCode = 400;
    throw error;
  }

  if (config.sampleDurationMs < config.sampleIntervalMs) {
    const error = new Error('采样时长不能小于采样间隔');
    error.statusCode = 400;
    throw error;
  }

  return config;
}

function getTelemetryGps(payload) {
  const latitude = rawToCoordinate(payload.lat);
  const longitude = rawToCoordinate(payload.lon);
  const fix = Number(payload.fix) > 0;

  if (!fix || latitude === null || longitude === null) {
    return null;
  }

  return { latitude, longitude, fix: Number(payload.fix), satellites: Number(payload.sat) || 0 };
}

function distanceMeters(a, b) {
  const earthRadiusM = 6371000;
  const lat1 = a.latitude * Math.PI / 180;
  const lat2 = b.latitude * Math.PI / 180;
  const deltaLat = (b.latitude - a.latitude) * Math.PI / 180;
  const deltaLon = (b.longitude - a.longitude) * Math.PI / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function normalizeTelemetrySample(payload, options) {
  const gps = getTelemetryGps(payload);
  const water = {
    ph: scaledNumber(payload.ph, 100),
    tempC: Number(payload.tv) === 1 ? scaledNumber(payload.tc, 100) : null,
    turbidity: payload.tb === undefined || payload.tb === null ? null : Number(payload.tb),
    phRaw: payload.phr ?? null,
    phMv: payload.phmv ?? null,
    turbidityRaw: payload.tbr ?? null,
    turbidityMv: payload.tbmv ?? null,
    turbidityDigital: payload.td ?? null,
    turbidityStatus: payload.tbv ?? null,
    temperatureValid: Number(payload.tv) === 1,
  };
  const edgeAi = {
    phNormal: payload.aiphn === undefined || payload.aiphn === null ? null : Number(payload.aiphn) === 1,
    temperatureNormal: payload.aitn === undefined || payload.aitn === null ? null : Number(payload.aitn) === 1,
  };

  return {
    id: makeId('sample'),
    zoneId: options.zoneId,
    receivedAt: options.receivedAt || state.lastMessageAt || nowIso(),
    savedAt: nowIso(),
    source: options.source,
    attributionMethod: options.attributionMethod,
    gpsValidation: options.gpsValidation,
    water,
    edgeAi,
    gps: {
      fix: payload.fix ?? null,
      satellites: payload.sat ?? null,
      latitude: gps ? gps.latitude : null,
      longitude: gps ? gps.longitude : null,
      rawLat: payload.lat ?? null,
      rawLon: payload.lon ?? null,
    },
    imu: {
      valid: Number(payload.iv) === 1,
      roll: Number(payload.iv) === 1 ? scaledNumber(payload.ir, 100) : null,
      pitch: Number(payload.iv) === 1 ? scaledNumber(payload.ip, 100) : null,
      yaw: Number(payload.iv) === 1 ? scaledNumber(payload.iy, 100) : null,
      raw: {
        iv: payload.iv ?? null,
        ir: payload.ir ?? null,
        ip: payload.ip ?? null,
        iy: payload.iy ?? null,
        ib: payload.ib ?? null,
        ia: payload.ia ?? null,
      },
    },
    raw: payload,
    deletedAt: null,
  };
}

function normalizeTestSample(body, zoneId) {
  const ph = requireFiniteNumber(body.ph, '测试 pH');
  const tempC = requireFiniteNumber(body.tempC, '测试水温');
  const turbidity = requireFiniteNumber(body.turbidity, '测试浊度');

  return {
    id: makeId('sample'),
    zoneId,
    receivedAt: nowIso(),
    savedAt: nowIso(),
    source: 'advanced_test',
    attributionMethod: 'advanced_test',
    gpsValidation: {
      validated: false,
      arrivalMode: 'unverified_test',
      distanceToTargetM: null,
    },
    water: {
      ph,
      tempC,
      turbidity,
      phRaw: null,
      phMv: null,
      turbidityRaw: null,
      turbidityMv: null,
      turbidityDigital: null,
      temperatureValid: true,
    },
    edgeAi: {
      phNormal: null,
      temperatureNormal: null,
    },
    gps: {
      fix: null,
      satellites: null,
      latitude: null,
      longitude: null,
      rawLat: null,
      rawLon: null,
    },
    imu: {
      valid: false,
      roll: null,
      pitch: null,
      yaw: null,
      raw: {},
    },
    raw: { t: 'advanced_test', ph, tempC, turbidity },
    deletedAt: null,
  };
}

function saveSample(sample) {
  state.samples.unshift(sample);
  appendJsonLine(SAMPLES_FILE, sample);
  rebuildLatestSampleByZone();
  broadcast({
    kind: 'sample-created',
    sample,
    latestSampleByZone: state.latestSampleByZone,
    sampling: state.sampling,
  });
  return sample;
}

function setSamplingStatus(status, warning = null) {
  state.sampling.status = status;
  state.sampling.warning = warning;
}

function broadcastSamplingUpdate() {
  broadcast({ kind: 'sampling-update', sampling: state.sampling });
}

function completeSamplingTask() {
  if (state.sampling.task) {
    state.sampling.task.phase = 'completed';
    state.sampling.task.completedAt = nowIso();
  }

  state.sampling.task = null;
  setSamplingStatus('idle', null);
  broadcastSamplingUpdate();
}

function pauseSamplingTask(warningCode, nowMs) {
  const task = state.sampling.task;
  if (!task || task.phase === 'paused_warning') {
    return;
  }

  task.previousPhase = task.phase;
  task.phase = 'paused_warning';
  task.pausedAt = nowIso();
  task.pausedAtMs = nowMs;
  task.warning = warningCode;
  setSamplingStatus('paused_warning', warningCode);
  broadcastSamplingUpdate();
}

function enterStabilizing(task, arrivalMode, nowMs, distanceToTargetM, resumeFromSampling = false) {
  task.phase = 'stabilizing';
  task.arrivalMode = arrivalMode;
  task.arrivedAt = nowIso();
  task.arrivedAtMs = nowMs;
  task.distanceToTargetM = distanceToTargetM;
  task.resumeFromSampling = resumeFromSampling;
  setSamplingStatus('stabilizing', null);
  broadcastSamplingUpdate();
}

function enterSampling(task, nowMs) {
  if (task.resumeFromSampling && task.pausedAtMs && task.samplingEndsAtMs) {
    task.samplingEndsAtMs += nowMs - task.pausedAtMs;
    task.totalPausedMs = (task.totalPausedMs || 0) + (nowMs - task.pausedAtMs);
  }

  task.phase = 'sampling';
  task.resumeFromSampling = false;
  task.pausedAtMs = null;
  task.pausedAt = null;
  task.warning = null;

  if (!task.samplingStartedAtMs) {
    task.samplingStartedAt = nowIso();
    task.samplingStartedAtMs = nowMs;
    task.samplingEndsAtMs = nowMs + state.sampling.config.sampleDurationMs;
  }

  task.samplingEndsAt = new Date(task.samplingEndsAtMs).toISOString();
  setSamplingStatus('sampling', null);
  broadcastSamplingUpdate();
}

function getCurrentTaskDistance(payload) {
  const task = state.sampling.task;
  const gps = getTelemetryGps(payload);
  if (!task || !gps) {
    return { gps, distance: null };
  }

  const target = getCurrentPointTarget(task);
  return { gps, distance: target ? distanceMeters(gps, target) : null };
}

function saveFormalSample(payload, task, distance, arrivalMode) {
  const sample = normalizeTelemetrySample(payload, {
    zoneId: task.zoneId,
    source: 'serial',
    attributionMethod: 'active_target',
    gpsValidation: {
      validated: true,
      arrivalMode,
      distanceToTargetM: distance === null ? null : Number(distance.toFixed(2)),
    },
  });

  saveSample(sample);
}

function processNavigating(payload, task, nowMs, distance) {
  const config = state.sampling.config;
  const ageMs = nowMs - task.startedAtMs;

  if (distance !== null && distance <= config.arrivalRadiusM) {
    enterStabilizing(task, 'strict_1m', nowMs, distance);
    return;
  }

  if (distance !== null && distance <= config.fallbackRadiusM && ageMs >= config.fallbackAfterMs) {
    enterStabilizing(task, 'fallback_5m_after_1min', nowMs, distance);
    return;
  }

  if (ageMs >= config.targetTimeoutMs) {
    pauseSamplingTask('target_timeout', nowMs);
  }
}

function processStabilizing(payload, task, nowMs, distance) {
  const config = state.sampling.config;

  if (distance === null || distance > config.fallbackRadiusM) {
    pauseSamplingTask(task.samplingStartedAtMs ? 'left_sampling_radius' : 'left_radius_before_sampling', nowMs);
    return;
  }

  if (nowMs - task.arrivedAtMs >= config.stabilizationMs) {
    enterSampling(task, nowMs);
  }
}

function processSampling(payload, task, nowMs, distance) {
  const config = state.sampling.config;

  if (distance === null || distance > config.fallbackRadiusM) {
    pauseSamplingTask('left_sampling_radius', nowMs);
    return;
  }

  let savedSample = false;
  if (!task.lastSampleSavedAtMs || nowMs - task.lastSampleSavedAtMs >= config.sampleIntervalMs) {
    saveFormalSample(payload, task, distance, task.arrivalMode || 'strict_1m');
    task.lastSampleSavedAt = nowIso();
    task.lastSampleSavedAtMs = nowMs;
    savedSample = true;
  }

  if (nowMs >= task.samplingEndsAtMs) {
    void advanceToNextPoint(task, nowMs);
    return;
  }

  if (savedSample) {
    broadcastSamplingUpdate();
  }
}

function processPaused(payload, task, nowMs, distance) {
  if (task.warning === 'target_timeout' || task.warning === 'target_send_failed') {
    return;
  }

  if (distance !== null && distance <= state.sampling.config.fallbackRadiusM) {
    enterStabilizing(task, task.arrivalMode || 'resume_5m', nowMs, distance, task.previousPhase === 'sampling');
  }
}

function processSamplingData(payload) {
  const task = state.sampling.task;
  if (!task) {
    return;
  }

  const nowMs = Date.now();
  const { distance } = getCurrentTaskDistance(payload);

  if (task.phase === 'navigating') {
    processNavigating(payload, task, nowMs, distance);
  } else if (task.phase === 'stabilizing') {
    processStabilizing(payload, task, nowMs, distance);
  } else if (task.phase === 'sampling') {
    processSampling(payload, task, nowMs, distance);
  } else if (task.phase === 'paused_warning') {
    processPaused(payload, task, nowMs, distance);
  }
}

function getZoneCenter(zone) {
  return zone && zone.geometry ? zone.geometry.center : null;
}

function generateSamplePoints(zone) {
  const center = getZoneCenter(zone);
  if (!center || !zone.geometry) {
    return [center || { latitude: 0, longitude: 0 }];
  }

  const lengthM = Number(zone.geometry.lengthM) || 20;
  const widthM = Number(zone.geometry.widthM) || 10;
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLon = 111320 * Math.cos(center.latitude * Math.PI / 180) || 111320;
  const halfLat = ((lengthM / 2) * SAMPLE_POINT_INSET_RATIO) / metersPerDegreeLat;
  const halfLon = ((widthM / 2) * SAMPLE_POINT_INSET_RATIO) / metersPerDegreeLon;

  const south = center.latitude - halfLat;
  const north = center.latitude + halfLat;
  const west = center.longitude - halfLon;
  const east = center.longitude + halfLon;
  const midLat = center.latitude;
  const midLon = center.longitude;

  return [
    { latitude: south, longitude: west },
    { latitude: south, longitude: midLon },
    { latitude: south, longitude: east },
    { latitude: midLat, longitude: east },
    { latitude: north, longitude: east },
    { latitude: north, longitude: midLon },
    { latitude: north, longitude: west },
    { latitude: midLat, longitude: west },
  ];
}

function getCurrentPointTarget(task) {
  if (!task || !task.samplePoints || task.samplePoints.length === 0) {
    return task ? task.target : null;
  }
  const index = Math.min(task.currentPointIndex || 0, task.samplePoints.length - 1);
  return task.samplePoints[index];
}

function resetPointSamplingState(task, nowMs) {
  task.arrivalMode = null;
  task.arrivedAt = null;
  task.arrivedAtMs = null;
  task.samplingStartedAt = null;
  task.samplingStartedAtMs = null;
  task.samplingEndsAt = null;
  task.samplingEndsAtMs = null;
  task.lastSampleSavedAt = null;
  task.lastSampleSavedAtMs = null;
  task.pausedAt = null;
  task.pausedAtMs = null;
  task.totalPausedMs = 0;
  task.warning = null;
  task.startedAtMs = nowMs;
  task.startedAt = nowIso();
  task.target = getCurrentPointTarget(task);
}

async function advanceToNextPoint(task, nowMs) {
  const nextIndex = (task.currentPointIndex || 0) + 1;
  if (nextIndex >= (task.samplePoints ? task.samplePoints.length : 1)) {
    completeSamplingTask();
    return false;
  }

  task.currentPointIndex = nextIndex;
  resetPointSamplingState(task, nowMs);

  try {
    await dispatchCurrentTarget(task);
  } catch (error) {
    console.warn(`发送下一个采样目标失败: ${error.message}`);
  }

  return true;
}

function hasActiveSamplingTask() {
  return Boolean(state.sampling.task && ['dispatching_target', 'navigating', 'stabilizing', 'sampling', 'paused_warning', 'cancelling'].includes(state.sampling.task.phase));
}

function buildBoundaryPayload(zone) {
  const geometry = zone?.geometry;
  const center = geometry?.center;
  if (!geometry || geometry.type !== 'axis_aligned_rectangle' || !center) {
    return {};
  }

  return {
    bt: 'rect',
    bclat: Math.round(Number(center.latitude) * 10000000),
    bclon: Math.round(Number(center.longitude) * 10000000),
    blen: Number(geometry.lengthM),
    bwid: Number(geometry.widthM),
  };
}

function buildZoneTargetPayload(zone, target) {
  const point = target || zone.geometry.center;
  const config = state.sampling.config;
  return {
    t: 'target',
    zone: zone.id,
    lat: Math.round(point.latitude * 10000000),
    lon: Math.round(point.longitude * 10000000),
    r: config.fallbackRadiusM,
    ar: config.arrivalRadiusM,
    rr: config.returnRadiusM || config.fallbackRadiusM,
    bm: config.boundaryMarginM || 0,
    ...buildBoundaryPayload(zone),
  };
}

async function dispatchCurrentTarget(task) {
  if (!task || state.sampling.task !== task) {
    const error = new Error('当前没有可发送目标的采样任务');
    error.statusCode = 409;
    throw error;
  }

  const zone = getZoneById(task.zoneId);
  if (!zone) {
    const error = new Error('采样任务对应的区域不存在');
    error.statusCode = 404;
    throw error;
  }

  const target = getCurrentPointTarget(task);
  const payload = buildZoneTargetPayload(zone, target);
  task.target = target;
  task.phase = 'dispatching_target';
  task.warning = null;
  setSamplingStatus('dispatching_target', null);
  broadcastSamplingUpdate();

  try {
    await writeSerialMessage(JSON.stringify(payload), { appendNewline: true, broadcast: false });
  } catch (error) {
    if (state.sampling.task === task) {
      pauseSamplingTask('target_send_failed', Date.now());
    }
    throw error;
  }

  if (state.sampling.task === task && !task.cancelRequested) {
    const nowMs = Date.now();
    task.phase = 'navigating';
    task.startedAt = nowIso();
    task.startedAtMs = nowMs;
    task.pausedAt = null;
    task.pausedAtMs = null;
    task.warning = null;
    setSamplingStatus('navigating', null);
    broadcastSamplingUpdate();
  }

  return payload;
}

function startZoneTask(zone) {
  const nowMs = Date.now();
  const samplePoints = generateSamplePoints(zone);
  const firstTarget = samplePoints[0] || zone.geometry.center;
  state.sampling.task = {
    id: makeId('task'),
    zoneId: zone.id,
    samplePoints,
    currentPointIndex: 0,
    target: firstTarget,
    startedAt: nowIso(),
    startedAtMs: nowMs,
    phase: 'dispatching_target',
    arrivalMode: null,
    arrivedAt: null,
    arrivedAtMs: null,
    samplingStartedAt: null,
    samplingStartedAtMs: null,
    samplingEndsAt: null,
    samplingEndsAtMs: null,
    lastSampleSavedAt: null,
    lastSampleSavedAtMs: null,
    pausedAt: null,
    pausedAtMs: null,
    totalPausedMs: 0,
    warning: null,
  };
  setSamplingStatus('dispatching_target', null);
  broadcastSamplingUpdate();
  return state.sampling.task;
}

function getSamplesForStatus() {
  return visibleSamples(false).slice(0, STATUS_SAMPLE_LIMIT);
}

function getStatusPayload() {
  return {
    status: getSerialStatus(),
    latestBoot: state.latestBoot,
    latestData: state.latestData,
    latestDataReceivedAt: state.latestDataReceivedAt,
    history: state.history,
    logs: state.logs,
    zones: visibleZones(true),
    samples: getSamplesForStatus(),
    latestSampleByZone: state.latestSampleByZone,
    sampling: state.sampling,
    builtinSpecies: BUILTIN_SPECIES,
    llmConfig: publicLlmConfig(),
    gpsTest: getGpsTestStatus(),
  };
}

function cleanLineBuffer(buffer) {
  let startIndex = 0;

  while (startIndex < buffer.length && (buffer[startIndex] === 0xff || buffer[startIndex] === 0x00)) {
    startIndex += 1;
  }

  const filtered = [];
  for (let i = startIndex; i < buffer.length; i += 1) {
    if (buffer[i] !== 0x00) {
      filtered.push(buffer[i]);
    }
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
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
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

function applyDecodedPayload(payload, receivedAt) {
  if (payload.t === 'boot') {
    state.latestBoot = payload;
  } else if (payload.t === 'data') {
    state.latestData = payload;
    state.latestDataReceivedAt = receivedAt;
    processSamplingData(payload);
  }
}

function handleDecodedLine(line) {
  if (!line) {
    return;
  }

  const receivedAt = nowIso();
  state.lastMessageAt = receivedAt;

  const log = addLog('RX', line);
  const decoded = parseDecodedPayloads(line);
  let entry = null;

  if (decoded.length > 0) {
    for (const item of decoded) {
      const type = item.payload.t || 'json';
      applyDecodedPayload(item.payload, receivedAt);
      entry = addHistory(type, item.raw, item.payload);
    }
  } else {
    entry = addHistory('text', line, null);
  }

  broadcast({
    kind: 'serial-message',
    status: getSerialStatus(),
    latestBoot: state.latestBoot,
    latestData: state.latestData,
    latestDataReceivedAt: state.latestDataReceivedAt,
    entry,
    log,
  });
}

function handleSerialChunk(chunk) {
  lineBuffer = Buffer.concat([lineBuffer, chunk]);

  while (true) {
    const lineFeedIndex = lineBuffer.indexOf(0x0a);
    if (lineFeedIndex === -1) {
      break;
    }

    let line = lineBuffer.subarray(0, lineFeedIndex);
    lineBuffer = lineBuffer.subarray(lineFeedIndex + 1);

    if (line.length > 0 && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1);
    }

    handleDecodedLine(cleanLineBuffer(line));
  }

  broadcast({ kind: 'serial-status', status: getSerialStatus() });
}

function resetPortState() {
  activePort = null;
  activeBaudRate = DEFAULT_BAUD_RATE;
  lineBuffer = Buffer.alloc(0);
}

function bindPortEvents(port) {
  port.on('data', (chunk) => {
    if (port === activePort) {
      handleSerialChunk(chunk);
    }
  });

  port.on('error', (error) => {
    if (port !== activePort) {
      return;
    }

    broadcast({
      kind: 'serial-error',
      status: getSerialStatus(),
      message: error.message || String(error),
    });
  });

  port.on('close', () => {
    if (port !== activePort) {
      return;
    }

    resetPortState();
    broadcast({ kind: 'serial-status', status: getSerialStatus() });
  });
}

function openSerialPort(portPath, baudRate) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path: portPath,
      baudRate,
      autoOpen: false,
    });

    port.open((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(port);
    });
  });
}

function closeActivePort() {
  return new Promise((resolve, reject) => {
    if (!activePort || !activePort.isOpen) {
      resetPortState();
      resolve();
      return;
    }

    activePort.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function writeToPort(buffer) {
  return new Promise((resolve, reject) => {
    if (!activePort || !activePort.isOpen) {
      reject(new Error('串口未连接'));
      return;
    }

    activePort.write(buffer, (writeError) => {
      if (writeError) {
        reject(writeError);
        return;
      }

      activePort.drain((drainError) => {
        if (drainError) {
          reject(drainError);
          return;
        }

        resolve();
      });
    });
  });
}

async function writeSerialMessage(message, options = {}) {
  const appendNewline = options.appendNewline !== false;
  const broadcastMode = Boolean(options.broadcast);
  let payloadBuffer = Buffer.from(message, 'utf8');

  if (appendNewline) {
    payloadBuffer = Buffer.concat([payloadBuffer, Buffer.from('\r\n', 'utf8')]);
  }

  if (broadcastMode) {
    payloadBuffer = Buffer.concat([Buffer.from('\xFF\xFF', 'utf8'), payloadBuffer]);
  }

  await writeToPort(payloadBuffer);

  const prefix = broadcastMode ? '[BROADCAST] ' : '';
  const suffix = appendNewline ? ' ↩' : '';
  const log = addLog('TX', `${prefix}${message}${suffix}`);
  broadcast({ kind: 'serial-log', status: getSerialStatus(), log });
  return log;
}

function sendError(res, error) {
  res.status(error.statusCode || 500).json({ message: error.message || String(error) });
}

initializeStorage();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, status: getSerialStatus() });
});

app.get('/api/status', (_req, res) => {
  res.json(getStatusPayload());
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
    sendError(res, error);
  }
});

app.get('/api/zones', (req, res) => {
  res.json({ zones: visibleZones(req.query.includeDeleted === '1') });
});

app.post('/api/zones', (req, res) => {
  try {
    const zone = normalizeZoneInput(req.body);
    state.zones.push(zone);
    saveZonesFile();
    broadcast({ kind: 'zones-updated', zones: visibleZones(true) });
    res.json({ ok: true, zone, zones: visibleZones(true) });
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/zones/:id', (req, res) => {
  try {
    const index = state.zones.findIndex((zone) => zone.id === req.params.id && !zone.deletedAt);
    if (index === -1) {
      res.status(404).json({ message: '区域不存在' });
      return;
    }

    state.zones[index] = normalizeZoneInput(req.body, state.zones[index]);
    saveZonesFile();
    rebuildLatestSampleByZone();
    broadcast({ kind: 'zones-updated', zones: visibleZones(true) });
    res.json({ ok: true, zone: state.zones[index], zones: visibleZones(true) });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/zones/:id', (req, res) => {
  const zone = getZoneById(req.params.id, { includeDeleted: true });
  if (!zone) {
    res.status(404).json({ message: '区域不存在' });
    return;
  }

  zone.deletedAt = nowIso();
  zone.updatedAt = nowIso();
  saveZonesFile();
  broadcast({ kind: 'zones-updated', zones: visibleZones(true) });
  res.json({ ok: true, zone, zones: visibleZones(true) });
});

app.post('/api/zones/:id/recover', (req, res) => {
  const zone = getZoneById(req.params.id, { includeDeleted: true });
  if (!zone) {
    res.status(404).json({ message: '区域不存在' });
    return;
  }

  zone.deletedAt = null;
  zone.updatedAt = nowIso();
  saveZonesFile();
  broadcast({ kind: 'zones-updated', zones: visibleZones(true) });
  res.json({ ok: true, zone, zones: visibleZones(true) });
});

app.get('/api/samples', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || STATUS_SAMPLE_LIMIT, 5000));
  let samples = visibleSamples(req.query.includeDeleted === '1');

  if (req.query.zoneId) {
    samples = samples.filter((sample) => sample.zoneId === req.query.zoneId);
  }

  res.json({ samples: samples.slice(0, limit), latestSampleByZone: state.latestSampleByZone });
});

app.delete('/api/samples/:id', (req, res) => {
  const sample = state.samples.find((item) => item.id === req.params.id);
  if (!sample) {
    res.status(404).json({ message: '样本不存在' });
    return;
  }

  sample.deletedAt = nowIso();
  rewriteSamplesFile();
  rebuildLatestSampleByZone();
  broadcast({ kind: 'samples-updated', samples: getSamplesForStatus(), latestSampleByZone: state.latestSampleByZone });
  res.json({ ok: true, samples: getSamplesForStatus(), latestSampleByZone: state.latestSampleByZone });
});

app.post('/api/samples/delete', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? new Set(req.body.ids) : new Set();
  const deletedAt = nowIso();
  let changed = false;

  for (const sample of state.samples) {
    if (ids.has(sample.id) && !sample.deletedAt) {
      sample.deletedAt = deletedAt;
      changed = true;
    }
  }

  if (changed) {
    rewriteSamplesFile();
    rebuildLatestSampleByZone();
    broadcast({ kind: 'samples-updated', samples: getSamplesForStatus(), latestSampleByZone: state.latestSampleByZone });
  }

  res.json({ ok: true, samples: getSamplesForStatus(), latestSampleByZone: state.latestSampleByZone });
});

app.post('/api/zones/:id/samples/delete', (req, res) => {
  const zone = getZoneById(req.params.id);
  if (!zone) {
    res.status(404).json({ message: '区域不存在' });
    return;
  }

  const deletedAt = nowIso();
  let changed = false;

  for (const sample of state.samples) {
    if (sample.zoneId === req.params.id && !sample.deletedAt) {
      sample.deletedAt = deletedAt;
      changed = true;
    }
  }

  if (changed) {
    rewriteSamplesFile();
    rebuildLatestSampleByZone();
    broadcast({ kind: 'samples-updated', samples: getSamplesForStatus(), latestSampleByZone: state.latestSampleByZone });
  }

  res.json({ ok: true, samples: getSamplesForStatus(), latestSampleByZone: state.latestSampleByZone });
});

app.get('/api/sampling', (_req, res) => {
  res.json({ sampling: state.sampling });
});

app.put('/api/sampling/config', (req, res) => {
  try {
    state.sampling.config = normalizeSamplingConfig(req.body);
    saveZonesFile();
    broadcastSamplingUpdate();
    res.json({ ok: true, sampling: state.sampling });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/targets/zone', async (req, res) => {
  const zone = getZoneById(req.body.zoneId);
  if (!zone) {
    res.status(404).json({ message: '请选择有效的养殖区域' });
    return;
  }

  if (hasActiveSamplingTask()) {
    res.status(409).json({ message: '当前已有采样任务，请先取消或等待完成后再发送新目标' });
    return;
  }

  const task = startZoneTask(zone);

  try {
    const payload = await dispatchCurrentTarget(task);
    if (state.sampling.task !== task || task.cancelRequested) {
      res.status(409).json({ message: '目标下发期间任务已被取消', sampling: state.sampling });
      return;
    }
    res.json({ ok: true, targetPayload: payload, sampling: state.sampling });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/sampling/retry-target', async (_req, res) => {
  const task = state.sampling.task;
  if (!task || task.phase !== 'paused_warning' || task.warning !== 'target_send_failed') {
    res.status(409).json({ message: '当前没有发送失败的采样目标可重试' });
    return;
  }

  try {
    const payload = await dispatchCurrentTarget(task);
    res.json({ ok: true, targetPayload: payload, sampling: state.sampling });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/sampling/cancel', async (_req, res) => {
  const task = state.sampling.task;
  const taskCancelled = Boolean(task);
  if (task) {
    task.cancelRequested = true;
    task.phase = 'cancelling';
    task.cancelledAt = nowIso();
    setSamplingStatus('cancelling', null);
    broadcastSamplingUpdate();
  }

  let stopCommandSent = false;
  let stopCommandError = null;
  try {
    await writeSerialMessage(JSON.stringify({ t: 'cmd', cmd: 'stop' }), { appendNewline: true, broadcast: false });
    stopCommandSent = true;
  } catch (error) {
    stopCommandError = error.message || String(error);
  }

  if (!task || state.sampling.task === task) {
    state.sampling.task = null;
    setSamplingStatus('idle', null);
    broadcastSamplingUpdate();
  }

  res.json({
    ok: true,
    taskCancelled,
    stopCommandSent,
    stopCommandError,
    sampling: state.sampling,
  });
});

app.post('/api/sampling/manual-sample', (req, res) => {
  const zone = getZoneById(req.body.zoneId);
  if (!zone) {
    res.status(404).json({ message: '请选择有效的养殖区域' });
    return;
  }

  if (!activePort || !activePort.isOpen) {
    res.status(409).json({ message: '串口未连接，不能保存正式手动样本' });
    return;
  }

  if (!state.latestData) {
    res.status(409).json({ message: '还没有可保存的最新遥测 data' });
    return;
  }

  const sample = normalizeTelemetrySample(state.latestData, {
    zoneId: zone.id,
    receivedAt: state.latestDataReceivedAt,
    source: 'manual',
    attributionMethod: 'manual_override',
    gpsValidation: {
      validated: false,
      arrivalMode: 'manual_override',
      distanceToTargetM: null,
    },
  });

  saveSample(sample);
  res.json({ ok: true, sample, samples: getSamplesForStatus(), latestSampleByZone: state.latestSampleByZone });
});

app.post('/api/sampling/test-sample', (req, res) => {
  try {
    const zone = getZoneById(req.body.zoneId);
    if (!zone) {
      res.status(404).json({ message: '请选择有效的养殖区域' });
      return;
    }

    const sample = normalizeTestSample(req.body, zone.id);
    saveSample(sample);
    res.json({ ok: true, sample, samples: getSamplesForStatus(), latestSampleByZone: state.latestSampleByZone });
  } catch (error) {
    sendError(res, error);
  }
});

// --- LLM 风险分析 API ---
app.get('/api/analysis/config', (_req, res) => {
  res.json({ llmConfig: publicLlmConfig() });
});

app.put('/api/analysis/config', (req, res) => {
  try {
    const body = req.body || {};
    const allowedProviders = new Set(['disabled', 'cloud', 'ollama', 'anthropic']);
    if (body.provider !== undefined) {
      if (!allowedProviders.has(body.provider)) {
        res.status(400).json({ message: '未知 LLM 来源' });
        return;
      }
      llmConfig.provider = body.provider;
    }
    if (body.cloudEndpoint !== undefined) llmConfig.cloudEndpoint = body.cloudEndpoint;
    if (body.cloudApiKey !== undefined && body.cloudApiKey !== '***') llmConfig.cloudApiKey = body.cloudApiKey;
    if (body.cloudModel !== undefined) llmConfig.cloudModel = body.cloudModel;
    if (body.ollamaEndpoint !== undefined) llmConfig.ollamaEndpoint = body.ollamaEndpoint;
    if (body.ollamaModel !== undefined) llmConfig.ollamaModel = body.ollamaModel;
    refreshLlmEnabled();
    saveLlmConfig();
    res.json({ ok: true, llmConfig: publicLlmConfig() });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/analysis/risk', async (req, res) => {
  try {
    const zoneId = req.body.zoneId;
    if (!zoneId) {
      res.status(400).json({ message: '缺少 zoneId' });
      return;
    }
    const weatherHint = typeof req.body.weatherHint === 'string' ? req.body.weatherHint : '';
    const result = await analyzeZoneRisk(zoneId, weatherHint);
    res.json({ ok: true, analysis: result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/analysis/risk/batch', async (req, res) => {
  try {
    const zones = visibleZones(false);
    const weatherHint = typeof req.body.weatherHint === 'string' ? req.body.weatherHint : '';
    const results = {};
    for (const zone of zones) {
      try {
        results[zone.id] = await analyzeZoneRisk(zone.id, weatherHint);
      } catch (error) {
        results[zone.id] = { level: 'unknown', summary: `分析失败: ${error.message}`, source: 'error' };
      }
    }
    res.json({ ok: true, analyses: results });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/analysis/chat', async (req, res) => {
  try {
    const zoneId = req.body.zoneId;
    if (!zoneId) {
      res.status(400).json({ message: '缺少 zoneId' });
      return;
    }
    const message = typeof req.body.message === 'string' ? req.body.message : '';
    const result = await analyzeZoneChat(zoneId, message);
    res.json({ ok: true, zoneId, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/gps-test/status', (_req, res) => {
  res.json({ gpsTest: getGpsTestStatus() });
});

app.post('/api/gps-test/open', async (req, res) => {
  const portPath = typeof req.body.path === 'string' ? req.body.path.trim() : '';
  const baudRate = Number(req.body.baudRate) || 38400;
  const allowedBaudRates = new Set([4800, 9600, 19200, 38400, 57600, 115200, 230400]);

  if (!portPath) {
    res.status(400).json({ message: '缺少 GPS 串口路径 path' });
    return;
  }
  if (!allowedBaudRates.has(baudRate)) {
    res.status(400).json({ message: '不支持的 GPS 波特率' });
    return;
  }
  if (gpsTestPort && gpsTestPort.isOpen) {
    res.status(409).json({ message: 'GPS 测试串口已连接，请先断开' });
    return;
  }
  if (activePort && activePort.isOpen && activePort.path === portPath) {
    res.status(409).json({ message: '该串口正被连接管理使用，请选择其他串口或先断开原连接' });
    return;
  }

  try {
    const port = await openSerialPort(portPath, baudRate);
    gpsTestPort = port;
    gpsTestBaudRate = baudRate;
    gpsTestLineBuffer = Buffer.alloc(0);
    gpsTestState.latest = null;
    gpsTestState.lastSentenceAt = null;
    gpsTestState.sentenceCount = 0;
    gpsTestState.byteCount = 0;
    gpsTestState.checksumErrors = 0;
    gpsTestState.lines = [];
    gpsTestState.track = [];
    bindGpsTestPortEvents(port);
    broadcast({ kind: 'gps-test-status', gpsTest: getGpsTestStatus() });
    res.json({ ok: true, message: `GPS 测试串口已连接 ${portPath} @ ${baudRate}`, gpsTest: getGpsTestStatus() });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/gps-test/close', async (_req, res) => {
  try {
    await closeGpsTestPort();
    res.json({ ok: true, message: 'GPS 测试串口已断开', gpsTest: getGpsTestStatus() });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/gps-test/clear', (_req, res) => {
  gpsTestState.latest = null;
  gpsTestState.lastSentenceAt = null;
  gpsTestState.sentenceCount = 0;
  gpsTestState.byteCount = 0;
  gpsTestState.checksumErrors = 0;
  gpsTestState.lines = [];
  gpsTestState.track = [];
  broadcast({ kind: 'gps-test-status', gpsTest: getGpsTestStatus() });
  res.json({ ok: true, message: 'GPS 测试数据已清空', gpsTest: getGpsTestStatus() });
});

app.post('/api/serial/open', async (req, res) => {
  const portPath = typeof req.body.path === 'string' ? req.body.path.trim() : '';
  const baudRate = Number(req.body.baudRate) || DEFAULT_BAUD_RATE;

  if (!portPath) {
    res.status(400).json({ message: '缺少串口路径 path' });
    return;
  }

  if (activePort && activePort.isOpen) {
    res.status(409).json({ message: '当前已有串口连接，请先断开' });
    return;
  }
  if (gpsTestPort && gpsTestPort.isOpen && gpsTestPort.path === portPath) {
    res.status(409).json({ message: '该串口正被 GPS 测试功能使用，请选择其他串口或先断开 GPS 测试' });
    return;
  }

  try {
    const port = await openSerialPort(portPath, baudRate);
    activePort = port;
    activeBaudRate = baudRate;
    lineBuffer = Buffer.alloc(0);
    bindPortEvents(port);

    broadcast({ kind: 'serial-status', status: getSerialStatus() });

    res.json({
      ok: true,
      message: `已连接 ${portPath} @ ${baudRate}`,
      status: getSerialStatus(),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/serial/close', async (_req, res) => {
  try {
    await closeActivePort();
    res.json({ ok: true, message: '串口已断开', status: getSerialStatus() });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/serial/send', async (req, res) => {
  const message = typeof req.body.message === 'string' ? req.body.message : '';
  const appendNewline = req.body.appendNewline !== false;
  const broadcastMode = Boolean(req.body.broadcast);

  if (!message.trim()) {
    res.status(400).json({ message: '发送内容不能为空' });
    return;
  }

  try {
    await writeSerialMessage(message, { appendNewline, broadcast: broadcastMode });
    res.json({ ok: true, message: '发送成功' });
  } catch (error) {
    sendError(res, error);
  }
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ kind: 'snapshot', ...getStatusPayload() }));
});

server.listen(HTTP_PORT, () => {
  console.log(`BOAT WebUI running at http://localhost:${HTTP_PORT}`);
});
