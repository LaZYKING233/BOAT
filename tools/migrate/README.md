# 环境迁移包（tools/migrate）

在**另一台 Windows 机器**上重建这套已验证的 STM32 构建/烧录环境。

> 参考机：`E:\STM32\BOAT`，Windows 11 26100 amd64
> 参考工具链：arm-none-eabi-gcc 14.3.1 / GNU Make 4.4.1 / OpenOCD 0.12.0 / Node v24.15.0

---

## 为什么二进制不在 git 里

整套工具链解压后约 **1.2 GB**（其中 GCC 一家 1.1 GB）。GitHub 单文件上限 100 MB、仓库建议 1 GB 以内，
塞进来会直接推不上去，clone 也会变得极慢。

所以这里放的是**可复现的安装描述 + 校验和**（`manifest.json`），二进制由脚本按固定 URL 拉取并校验哈希。
两条路都支持：

| 路径 | 前提 | 耗时 | 适用 |
|---|---|---|---|
| **A. 离线包** | 拿到 `_outdoor_kit` 目录（U 盘/网盘） | 1-2 分钟（纯拷贝） | 野外、弱网、要 100% 一致 |
| **B. 在线下载** | 能上 GitHub / arm.com / nodejs.org | 5-15 分钟（看网速） | 家里有网的小电脑 |

两条路装出来的环境**等价**（同一版本、同一目录布局），区别只是 GCC 的来源：
离线包里是 ST 打包版，在线下载是 ARM 官方版，都是 14.3.rel1，编译产物一致。

---

## 快速使用

### A. 有离线包

```powershell
powershell -ExecutionPolicy Bypass -File tools\migrate\bootstrap.ps1 -KitPath D:\_outdoor_kit
```

### B. 没离线包，直接下

```powershell
powershell -ExecutionPolicy Bypass -File tools\migrate\bootstrap.ps1
```

两种都会做同样 5 步：检查环境 → 装工具链（校验哈希）→ 生成 `env.ps1` → 修正 makefile 绝对路径 → 编译一次验收。

### 验收（建议清空重编译）

```powershell
powershell -ExecutionPolicy Bypass -File tools\migrate\verify.ps1 -Clean -WithHardware
```

全绿 + 退出码 0 才算装好。任何一项红都会列出原因并返回 1。

---

## 装到哪、改了什么

| 项 | 位置 / 行为 |
|---|---|
| 工具链 | `%LOCALAPPDATA%\boat-env\{gcc,make,openocd,node[,cubeprog]}` |
| 环境变量 | 生成 `%LOCALAPPDATA%\boat-env\env.ps1`；把 4 个 `bin` 追加到**用户** PATH（不动系统 PATH） |
| 注册表 | 不写 |
| 管理员权限 | 不需要 |
| 工程文件 | 只改 `Debug\makefile` 里写死的 `E:\STM32\BOAT` 绝对路径，改成当前实际路径（幂等） |
| 源码 | 不动 |

不想要用户 PATH 污染：加 `-NoUserPath`，之后所有命令走 `dev.ps1`（它会自动 dot-source `env.ps1`）。

---

## 日常命令

```powershell
dev.ps1 build                 # 增量编译
dev.ps1 clean                 # 清理
dev.ps1 rebuild               # 全量重编
dev.ps1 flash                 # 烧录 Debug\BOAT.elf
dev.ps1 serial                # 串口监视（自动挑唯一串口，多个会让你选）
dev.ps1 webui                 # 起 WebUI 并开浏览器
dev.ps1 doctor                # 工具链/串口/ST-Link/产物 一次看全
```

---

## 烧录的两条路

1. **STM32_Programmer_CLI**（离线包里有，最稳）：`-c port=SWD mode=UR -w <elf> -v -rst`
2. **OpenOCD**（在线模式一定有）：`-f <iface> -f target/stm32u5x.cfg -c "program <elf> verify reset exit"`

`dev.ps1 flash` 先试 1，失败自动落 2。两个坑已经踩平：

- **脚本目录不固定**：xpack 在 `openocd\scripts`，ST 打包版在 `scripts`。`dev.ps1` 按 `target/stm32u5x.cfg` 反查，不猜路径。
- **interface 配置不通用**：ST 打包版的 `stlink.cfg` 用 `hla` 驱动（和 swj-dp 冲突），上游/xpack 用 `st-link` 驱动。脚本会读文件内容自动选 `stlink.cfg` 或 `stlink-dap.cfg`。

xpack 版 OpenOCD 自带 `target/stm32u5x.cfg`（已实测确认，0.12.0-6）。

---

## 已知边界

- 只支持 **x64 Windows 10/11**。
- **不含** STM32CubeIDE 图形界面（改 `.ioc` 要用它；命令行构建不需要）。
- 不含 `资料/ 材料/ archive/`（约 2.9 GB 参考资料）。
- 首次烧录前若设备管理器里 ST-Link 带感叹号，需要装 ST-Link 驱动
  （离线包 `drivers\STLink\stlink_winusb_install.bat`，或 ST 官网）。

---

## 给 AI agent 的执行手册

如果这台机器是交给一个 agent 去配的，让它读 [AGENT-PLAYBOOK.md](AGENT-PLAYBOOK.md) —— 里面有分步命令、判定标准和回报模板。
