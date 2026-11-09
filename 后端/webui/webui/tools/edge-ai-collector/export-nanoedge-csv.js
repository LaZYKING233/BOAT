/**
 * 从 raw CSV 中导出 NanoEdge AI Studio 训练用 CSV
 *
 * 用法：
 *   node tools/edge-ai-collector/export-nanoedge-csv.js
 *
 * 输出：
 *   edge_ai_data/nanoedge_export/ph/ph_normal.csv
 *   edge_ai_data/nanoedge_export/ph/ph_abnormal.csv
 *   edge_ai_data/nanoedge_export/temperature/temperature_normal.csv
 *   edge_ai_data/nanoedge_export/temperature/temperature_abnormal.csv
 */

const fs = require('fs');
const path = require('path');

const RAW_DIR = path.resolve(__dirname, '..', '..', 'edge_ai_data', 'raw');
const OUT_DIR = path.resolve(__dirname, '..', '..', 'edge_ai_data', 'nanoedge_export');

// ── 模型字段定义 ──────────────────────────────────────────────

const MODEL_DEFS = {
  ph: {
    columns: ['ph_raw', 'ph_mv', 'ph', 'ph_delta', 'ph_mv_delta'],
    normalGlob: ['正常-水-01.csv', '正常-水-03.csv', '正常-水-04.csv', '正常-水-05.csv', '正常-空气-01.csv'],
    abnormalGlob: ['不正常-ph-01.csv', '不正常-ph-02.csv', '不正常-ph-03.csv'],
  },
  temperature: {
    columns: ['temperature', 'temperature_valid', 'temperature_delta'],
    normalGlob: ['正常-水-01.csv', '正常-水-03.csv', '正常-水-04.csv', '正常-水-05.csv', '正常-空气-01.csv'],
    abnormalGlob: ['不正常-tem-02.csv', '不正常-tem-03.csv', '不正常-tem-04.csv'],
  },
};

// ── 工具函数 ──────────────────────────────────────────────────

function readCsvRows(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  ⚠ 文件不存在，跳过: ${filePath}`);
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) {
    console.warn(`  ⚠ 文件为空（无数据行），跳过: ${filePath}`);
    return [];
  }

  const header = lines[0].split(',');
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    const values = parseCsvLine(trimmed);
    if (!values || values.length !== header.length) {
      console.warn(`  ⚠ 第 ${i + 1} 行列数不匹配，跳过`);
      continue;
    }

    const row = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = values[j];
    }
    rows.push(row);
  }

  return rows;
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function writeCsv(filePath, columns, rows) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const header = columns.join(',');
  const body = rows.map((row) => columns.map((col) => {
    const value = row[col] ?? '';
    if (/[",\r\n]/.test(String(value))) {
      return `"${String(value).replace(/"/g, '""')}"`;
    }
    return value;
  }).join(',')).join('\n');

  fs.writeFileSync(filePath, `${header}\n${body}\n`, 'utf8');
}

// ── 主流程 ────────────────────────────────────────────────────

function exportModel(modelName, def) {
  console.log(`\n========== ${modelName.toUpperCase()} 模型 ==========`);

  // 正常数据
  console.log(`\n[正常] 读取 ${def.normalGlob.length} 个文件...`);
  const normalRows = [];
  for (const fileName of def.normalGlob) {
    const filePath = path.join(RAW_DIR, fileName);
    console.log(`  → ${fileName}`);
    const rows = readCsvRows(filePath);
    console.log(`    读取 ${rows.length} 行`);
    normalRows.push(...rows);
  }
  console.log(`  合计 normal 行数: ${normalRows.length}`);

  // 异常数据
  console.log(`\n[异常] 读取 ${def.abnormalGlob.length} 个文件...`);
  const abnormalRows = [];
  for (const fileName of def.abnormalGlob) {
    const filePath = path.join(RAW_DIR, fileName);
    console.log(`  → ${fileName}`);
    const rows = readCsvRows(filePath);
    console.log(`    读取 ${rows.length} 行`);
    abnormalRows.push(...rows);
  }
  console.log(`  合计 abnormal 行数: ${abnormalRows.length}`);

  // 过滤有效行（关键字段非空）
  const keyCol = def.columns[0];
  const validNormal = normalRows.filter((row) => row[keyCol] !== '');
  const validAbnormal = abnormalRows.filter((row) => row[keyCol] !== '');
  console.log(`  有效 normal 行: ${validNormal.length} (过滤 ${normalRows.length - validNormal.length} 空行)`);
  console.log(`  有效 abnormal 行: ${validAbnormal.length} (过滤 ${abnormalRows.length - validAbnormal.length} 空行)`);

  // 写入输出
  const outNormalPath = path.join(OUT_DIR, modelName, `${modelName}_normal.csv`);
  const outAbnormalPath = path.join(OUT_DIR, modelName, `${modelName}_abnormal.csv`);

  writeCsv(outNormalPath, def.columns, validNormal);
  writeCsv(outAbnormalPath, def.columns, validAbnormal);

  console.log(`\n  输出:`);
  console.log(`    ${outNormalPath}`);
  console.log(`    ${outAbnormalPath}`);
}

// ── 入口 ──────────────────────────────────────────────────────

console.log('Edge AI NanoEdge CSV 导出工具');
console.log(`RAW 目录: ${RAW_DIR}`);
console.log(`输出目录: ${OUT_DIR}`);

exportModel('ph', MODEL_DEFS.ph);
exportModel('temperature', MODEL_DEFS.temperature);

console.log('\n========== 完成 ==========');
