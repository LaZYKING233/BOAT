# BOAT 户外便携开发环境（离线包）

> 目标：把这台电脑上"能编译、能烧录、能看串口、能开 WebUI"的整套环境，
> 打包成一个**不联网、不安装、不写注册表**的文件夹。拷到小电脑上，双击几个 bat 就能干活。

---

## 一、里面有什么

| 目录 | 内容 | 大小 |
|---|---|---|
| `env\gcc` | arm-none-eabi-gcc 14.3.1 + newlib（Cortex-M33 / 硬浮点） | ~1.1 GB |
| `env\make` | GNU Make 4.4.1 | ~6 MB |
| `env\openocd` | OpenOCD 0.12 + ST 官方脚本（`stm32u5x.cfg`） | ~10 MB |
| `env\cubeprog` | STM32CubeProgrammer v2.22 命令行（ST 官方烧录器） | ~134 MB |
| `env\node` | Node.js v24 便携版（给 WebUI 用） | ~200 MB |
| `project` | 整个工程（已排除 资料 / 材料 / archive） | ~50 MB |
| `drivers\STLink` | ST-Link USB 驱动 + 安装脚本 | ~2 MB |
| `1...7-*.bat` | 一键入口 | — |

合计约 **1.5 GB**。

---

## 二、四步上手（在小电脑上）

**第 0 步**：先把整个 `_outdoor_kit` 文件夹拷到小电脑的硬盘里（例如 `C:\BOAT`）。
从 U 盘直接双击也能跑，但编译会明显慢。

**第 1 步**：双击 `1-环境自检.bat`
应该看到 gcc / make / openocd / node 四个 `[OK]`，以及工程目录、串口列表。

**第 2 步**：双击 `2-编译固件.bat`
最后出现 `[OK] 编译成功` + `固件: BOAT.elf (~2.2 MB)`。
> 首次约 30–60 秒，之后增量编译 1–2 秒。

**第 3 步**：插上 ST-Link，双击 `3-烧录固件.bat`
先试 ST 官方 `STM32_Programmer_CLI`，失败会自动换 OpenOCD 再试一次。

**第 4 步**：双击 `4-串口监视.bat` 看板子日志；双击 `5-启动WebUI.bat` 开网页控制台
（浏览器自动打开 http://localhost:3000）

---

## 三、第一次插 ST-Link 要注意

如果 Windows 设备管理器里 ST-Link 带**黄色感叹号**，双击 `7-安装STLink驱动.bat`
（需要管理员，会弹 UAC，点"是"）。装完重新插一次 ST-Link。

ST-Link/V2-1（Nucleo、Discovery 板载的那种）通常免驱，插上就认；
单独的 ST-Link V2 小棒有时要装驱动。

---

## 四、小电脑需要什么

- Windows 10 / 11（64 位）
- 至少 3 GB 空闲硬盘
- 一个 USB-A 口（如果只有 Type-C，带个扩展坞）
- **不需要**装 STM32CubeIDE，**不需要**联网，**不需要**管理员权限（只有装 ST-Link 驱动那一步要）

---

## 五、常见问题

**Q：编译报 `No rule to make target ...STM32U5A5ZJTXQ_FLASH.ld`**
A：这是 CubeIDE 生成的 makefile 里写死了 `E:\STM32\BOAT` 绝对路径。
`2-编译固件.bat` 每次都会自动把这些路径改成当前实际位置；如果还报，
从原始工程重新拷一份 `Debug\makefile` 过去，再跑一次就行。

**Q：烧录报 `No debug probe detected` / `open failed`**
A：按顺序查——① 板子供电了吗 ② SWDIO / SWCLK / GND 接对了吗
③ 设备管理器里 ST-Link 有没有感叹号（有就跑 `7-安装STLink驱动.bat`）。

**Q：芯片之前被烧过、现在连不上**
A：整片擦除：
`env\cubeprog\bin\STM32_Programmer_CLI.exe -c port=SWD mode=UR -e all`

**Q：串口列表是空的**
A：USB 线插好、板子上电、看设备管理器"端口(COM 和 LPT)"里有没有设备。
板载 VCP 没驱动时，可以先换一个 CH340 / CP2102 的 USB 转串口模块顶上。

**Q：换了别的主控芯片**
A：改 `_internal\flash.ps1` 里的 `-f target/stm32u5x.cfg` 为目标型号。

---

## 六、这个包**做不到**的事

- **它不能让我远程操作你的小电脑。** 我控制不了另一台机器的屏幕和键盘，
  所以这里的做法是：我把环境调好、写成一键脚本，你只负责双击。
- 不含 STM32CubeIDE 图形界面（要看 .ioc 图形配置 / 调试器单步，得在那边自己装，或者远程回连这台机器）。
- 不含 `资料\` `材料\` `archive\` 这些参考材料（约 2.9 GB），需要的话单独拷。

---

## 七、以后怎么更新

改完代码，把这边最新的 `project` 目录覆盖过去即可；
或者在小电脑上 `git pull`（工程里带 .git 的话）。
