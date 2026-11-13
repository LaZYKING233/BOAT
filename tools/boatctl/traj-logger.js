
const fs = require('fs');
const path = 'E:\\STM32\\BOAT\\tools\\boatctl\\runs\\trajectory.csv';
let target = null;
const lines = ['iso,seq,fix,lat,lon,yaw_imu,compass,ns,lw,rw,dist_m'];
fs.writeFileSync(path, lines.join('\n') + '\n');
let n = 0;
async function tick() {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/status');
    const j = await res.json();
    const d = j.latestData;
    if (!d) return;
    const compass = ((360 - d.iy / 100) % 360 + 360) % 360;
    const row = [
      new Date().toISOString(), d.seq, d.fix, (d.lat / 1e7).toFixed(7), (d.lon / 1e7).toFixed(7),
      (d.iy / 100).toFixed(1), compass.toFixed(1), d.ns, d.lw, d.rw,
      d.nd == null ? '' : (d.nd / 100).toFixed(2)
    ].join(',');
    fs.appendFileSync(path, row + '\n');
    n += 1;
    if (n % 10 === 0) console.log('已记录 ' + n + ' 条  lat=' + (d.lat/1e7).toFixed(6) + ' lon=' + (d.lon/1e7).toFixed(6) + ' yaw=' + (d.iy/100).toFixed(1));
  } catch (e) { /* 忽略单次失败 */ }
}
setInterval(tick, 2000);
tick();
console.log('轨迹记录开始 -> ' + path);
