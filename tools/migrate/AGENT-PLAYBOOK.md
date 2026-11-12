# 迁移执行手册（给 AI agent）

> 你的任务：在**当前这台机器**上，把 BOAT 项目的构建/烧录环境配到"能编译、能烧录、能看串口、能起 WebUI"，
> 并给出可核验的证据。你读到这份文件时，说明用户已经把这台机器交给你了。

---

## 0. 硬约束（先读，别越界）

1. **不要安装 STM32CubeIDE**（1 GB+，本项目命令行构建不需要它）。
2. **不要改系统 PATH**。只允许追加到**用户** PATH（`bootstrap.ps1` 默认行为）。
3. **不要修改工程源码**（`Core/` `Hardware/` `WebUI/` `AI/` 一律不动）。
   唯一允许改的构建文件是 `Debug\makefile` 里写死的绝对路径，且必须用 `bootstrap.ps1` 改，不要手改。
4. **不要用管理员权限**做任何事（本流程不需要）。
5. 任何一步失败：**停下来，按第 5 节的表处理**，不要"自己想办法绕过"（比如换个编译器版本、手改 makefile、跳过校验）。
6. 不要把 `manifest.json` 里的哈希"改成能过"的值。

---

## 1. 前置检查（30 秒）

依次执行并把输出记下来：

```powershell
# 1.1 系统
[Environment]::OSVersion.VersionString
[Environment]::Is64BitOperatingSystem

# 1.2 位置（记下绝对路径，后面要用）
(Get-Location).Path
Test-Path .\Debug\makefile
Test-Path .\Core\Src\main.c

# 1.3 空间（至少 3 GB 可用）
Get-PSDrive C | Select-Object Used,Free
```

**判定**：`Is64BitOperatingSystem` 必须是 `True`；`Debug\makefile` 与 `main.c` 必须都是 `True`。

---

## 2. 选路径

问用户 / 自己探测：**有没有 `_outdoor_kit` 这个离线包目录？**

```powershell
# 常见位置
@('D:\_outdoor_kit', 'E:\_outdoor_kit', "$env:USERPROFILE\Desktop\_outdoor_kit") |
  Where-Object { Test-Path (Join-Path $_ 'env\gcc\bin\arm-none-eabi-gcc.exe') }
```

- 有输出 → 走 **路径 A**
- 没有 → 走 **路径 B**（需要能访问 github.com / arm.com / nodejs.org）

---

## 3. 执行安装

### 路径 A：离线包（不联网，最快）

```powershell
powershell -ExecutionPolicy Bypass -File tools\migrate\bootstrap.ps1 -KitPath <上一步找到的目录>
```

### 路径 B：在线下载（约 330 MB）

```powershell
powershell -ExecutionPolicy Bypass -File tools\migrate\bootstrap.ps1
```

**期望输出**（关键行；路径 A 显示"已从离线包复制"，路径 B 显示"校验通过 + 已解压"）：

```
>>> 0/5 环境检查
  [OK] 操作系统: ...
  [OK] 安装盘可用空间: xx GB
>>> 1/5 安装工具链
  [OK] arm-none-eabi-gcc 14.3.rel1 校验通过
  [OK] ... 已解压到 C:\Users\<user>\AppData\Local\boat-env\gcc
  ...
>>> 4/5 编译验收
  [OK] 编译成功，用时 x.x 秒
  [OK] 产物: ...\Debug\BOAT.elf（2,270 KB）
>>> 5/5 结果
  环境已就绪。
```

**判定**：最后一行必须是 `环境已就绪。`，且退出码 0。
退出码 1 时看它打印的 `[X]` 行，按第 5 节处理。

---

## 4. 独立验收（必做，不能只看 bootstrap 说成功）

```powershell
powershell -ExecutionPolicy Bypass -File tools\migrate\verify.ps1 -Clean -WithHardware
```

**必须看到**：

1. 四个工具都有版本号（gcc 14.3.1 / make 4.4.1 / openocd 0.12.0 / node v24.x）
2. `Debug\makefile`、`objects.list`、`BOAT.ioc`、`.ld`、`main.c`、`WebUI\package.json` 全 OK
3. `[OK] 编译成功`，且 `text 段` 在 `[95000, 130000]` 区间内
4. `BOAT.elf` 约 2.2 MB
5. 结尾 `验收通过：这台机器可以编译、可以烧录。`
6. **退出码 0**

拿到退出码：

```powershell
powershell -ExecutionPolicy Bypass -File tools\migrate\verify.ps1 -Clean -WithHardware
"EXITCODE=$LASTEXITCODE"
```

> 注意：`text` 段为 0 或明显偏小，通常说明链接没成功（比如 NanoEdge `.a` 没参与链接），别放过。
> 参考值：`text 111020 / data 496 / bss 15256`。

---

## 5. 失败处理表

| 现象 | 原因 | 处理 |
|---|---|---|
| 下载卡住 / 超时 | 网络到 GitHub 或 arm.com 不稳 | 重跑同一条命令（脚本用 `curl -C -` 支持断点续传，会复用缓存）；连续 3 次失败 → 改用路径 A |
| `校验失败（哈希不匹配）` | 下到了 HTML 错误页 / 代理返回了篡改内容 | 删 `%LOCALAPPDATA%\boat-env\_cache\<name>.zip` 重跑；仍失败就换路径 A，**不要**放宽校验 |
| `解压后找不到 xxx.exe` | 上游压缩包结构变了 | 记录下来，别自己 hack 解压；改用路径 A，并把现象回报用户 |
| make 报 `No rule to make target ...FLASH.ld` | makefile 绝对路径没修正（或仓库不是完整的） | 重跑 `bootstrap.ps1`（第 3 步会自动修，幂等）；确认 `STM32U5A5ZJTXQ_FLASH.ld` 在仓库根目录 |
| make 报 `arm-none-eabi-gcc: command not found` | PATH 没生效 | 在**同一个 powershell 进程**里先 `. "$env:LOCALAPPDATA\boat-env\env.ps1"` 再编译；或直接用 `dev.ps1 build` |
| 编译报链接错误 / undefined reference | 缺 `AI/*.a` 或 `Drivers` 不全 | 确认 clone 完整（`AI/ph/libneai_ph.a` 存在）；`.gitignore` 不含 `*.a` |
| 烧录 `No debug probe detected` | 没插 ST-Link / 没驱动 / 接线错 | 先看设备管理器；带感叹号就装驱动（离线包 `drivers\STLink`）；不要重试超过 2 次 |
| 烧录 `error: unable to find a matching CMSIS-DAP device` | 用了 DAP 接口但硬件是 ST-Link | 换 `-f interface/stlink-dap.cfg`（`dev.ps1 flash` 已默认用它） |

---

## 6. 可选：装个顺手的编辑器

只有用户明确要求时才做，且用 winget（不改系统 PATH）：

```powershell
winget install --id Microsoft.VisualStudioCode -e --scope user
```

---

## 7. 回报模板（按这个格式回给用户，别自由发挥）

```
【环境迁移结果】成功 / 失败

机器：<Windows 版本> <架构>，仓库路径 <path>
来源：离线包 <path> / 在线下载
安装目录：<InstallRoot>
耗时：约 <n> 分钟

工具链：
  arm-none-eabi-gcc  <version>
  make               <version>
  openocd            <version>
  node               <version>

验收（verify.ps1 -Clean -WithHardware）：
  退出码 <0/1>
  text/data/bss  = <x>/<y>/<z>
  BOAT.elf       = <size> KB
  串口           = <列表 或 无>
  ST-Link        = <检测到 或 未检测到>

遗留问题：<没有就写"无">
```

---

## 8. 交付后提醒用户的话（照抄）

> 环境好了。日常用这四条：`dev.ps1 build` / `flash` / `serial` / `webui`。
> 新开终端如果直接敲 `make` 说找不到，是因为 PATH 要重开窗口才生效；或者先用 `dev.ps1`。
> 第一次烧录前确认 ST-Link 没感叹号。出门前记得把 `_outdoor_kit` 也带上——断网时它就是你的第二条命。
