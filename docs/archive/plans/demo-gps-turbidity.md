# 演示版：浊度降到清水范围 + GPS 电脑定位兜底

## 目标
复赛现场演示用 `演示/WebUI演示/` 版本。两件事：
1. 浊度造假数据从 15 NTU 降到清水范围（~3 NTU）。
2. 船端 GPS 没 fix 时，用浏览器定位（电脑实际位置）作为船位和地图中心；5 个演示区域围绕实际位置重新排布。船端有真实 fix 时优先用真实 GPS。

## 改动文件
- `演示/WebUI演示/server.js`
- `演示/WebUI演示/public/app.js`

---

## Part 1：浊度降到 ~3 NTU（4 处）

`server.js` 当前浊度写死 15 NTU、波动 ±2。改为基准 3 NTU、波动 ±1（范围 2~4 NTU，清水）：

| 行 | 当前 | 改为 |
|---|---|---|
| 1532（未连串口默认 latestData） | `tb: 15` | `tb: 3` |
| 1542（baseTb 兜底） | `\|\| 15` | `\|\| 3` |
| 1565（tbJitter 振幅） | `* 2` | `* 1` |
| 1728（覆盖真实串口数据） | `payload.tb = 15` | `payload.tb = 3` |

---

## Part 2：GPS 电脑定位兜底

### 现状
- `applyDecodedPayload` (server.js:1719) 无条件覆盖 `fix=1, sat=8, lat=345001000, lon=1040001000`（zone_A 中心），忽略真实 GPS。
- 区域 seed (server.js:791 `seedZones`) 写死在 (34.5, 104.0) 附近。
- 前端 `boatCoords()` (app.js:148) `fix<=0` 不画船；未用 `navigator.geolocation`。

### 后端 server.js 改动

**A. 新增 state 字段**
- `state.browserLocation = null`（{latitude, longitude}）
- `state.locationBase = null`（区域排布基准点；= 船实际位置）

**B. 新增接口 `POST /api/browser-location`**
- 入参 `{latitude, longitude}`，存入 `state.browserLocation`
- 调用 `establishLocationBase(browserLocation)`：
  - 若 `state.locationBase` 已设（已由 MCU 真实 GPS 建立过）-> 不覆盖（MCU 优先），仅记录 browserLocation 备用
  - 否则 -> 设 `state.locationBase = browserLocation`，re-seed 区域围绕该点，广播 zones
- 若当前 `state.latestData` 无 fix -> 用该位置建一个 latestData（fix=1, sat=8, lat/lon=电脑定位×1e7, tb=3, aiphn=1, aitn=1），广播 telemetry
- 返回 `{ok:true, locationBase}`

**C. `applyDecodedPayload` (1719) 改逻辑**
```
真实 fix = Number(payload.fix)>0 且 rawToCoordinate(lat/lon) 有效
if (真实 fix) {
    // 用真实 GPS，不覆盖 lat/lon/fix/sat
    state.locationBase = {真实 lat/lon}   // MCU 优先建立基准
    // 若区域还未围绕任何基准排布 -> re-seed 围绕真实 GPS
} else {
    // 船端 GPS 挂了 -> 用电脑定位
    if (state.browserLocation) {
        payload.fix = 1; payload.sat = 8;
        payload.lat = round(browserLocation.latitude * 1e7);
        payload.lon = round(browserLocation.longitude * 1e7);
    } else {
        payload.fix = 0;  // 电脑也没给定位 -> 显示未定位
    }
}
// 保留原有：aiphn=1, aitn=1 强制可信；demoSamplingTimer 运行时保留 nav 状态、跳过真实 GPS 距离状态机
```

**D. `seedZones(baseLat, baseLon)` 改为接受基准点**
- 默认 base = (34.5, 104.0)（电脑拒绝定位时的兜底）
- 5 个区域围绕基准点小偏移（沿用现有 0.0002 步长，约 20m 间距）
- 新增 `reseedZonesAround(baseLat, baseLon)`：调 seedZones + 保存 + 广播 `{kind:'zones-updated', zones}`

### 前端 app.js 改动

**E. 页面加载获取电脑定位**
- 在初始化（DOM ready / 首次 render 后）调 `navigator.geolocation.getCurrentPosition(success, error, {enableHighAccuracy:true, timeout:8000})`
- success：`POST /api/browser-location {latitude, longitude}`
- error/fallback：不发请求（后端 seedZones 默认已在 34.5,104.0，区域至少能显示）
- 注：localhost:3000 下浏览器定位可用（非 HTTPS 限制不适用 localhost）

**F. 地图/船位无需大改**
- `boatCoords()` 已在 fix>0 时画船；后端现在会令 fix=1（真实或电脑定位），所以船会画出来
- DEFAULT_MAP_CENTER 保持 (34.5, 104.0)，但船出现后会 autoCenter 到船位（现有逻辑 app.js:456），所以地图会自动跟到实际位置

### 运行时效果
1. 打开 http://localhost:3000 -> 浏览器弹定位授权 -> 允许
2. 后端收到电脑定位 -> 区域 A~E 重新排布到电脑位置周围 -> 船标出现在电脑位置 -> 地图自动居中
3. 点区域卡片 -> "开始巡检" -> `demoSamplingTimer` 模拟采样推进（船在区域采样点间"移动"，浊度 2~4 NTU，AI 判 normal）
4. 若现场船端 GPS 有真实 fix（户外）-> 优先用真实 GPS，区域围绕真实 GPS 排布
5. 若电脑拒绝定位 -> 区域留在默认 (34.5, 104.0)，船端有真实 fix 才显示船

---

## 不在本次范围
- MCU 完全挂掉（无任何串口数据）时船怎么"动"演示 -- 你说还没想法，等定位正确后再定。当前方案在 MCU 挂、电脑有定位时，船会静态显示在电脑位置、巡检模拟照常跑（船在采样点间跳转）。

## 验证
- 启动 `演示/WebUI演示`，浏览器允许定位 -> 地图应显示电脑实际位置 + 5 区域 + 船
- 看左栏浊度数值应在 2~4 NTU
- 点区域开始巡检 -> 采样模拟推进、AI 回复 normal
