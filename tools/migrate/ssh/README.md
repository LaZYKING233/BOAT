# SSH / Remote-SSH（Tailscale 内网）

目标：小电脑在外面，通过 Tailscale 连回参考机改代码、跑编译，
ST-Link 插在小电脑上本地烧录。

    ┌──────────────┐        Tailscale (WireGuard)        ┌──────────────┐
    │  小电脑       │ ──────────────────────────────────▶ │  参考机       │
    │  VS Code      │   ssh admin@100.92.185.68           │  sshd :22    │
    │  + OpenOCD    │ ◀────────────────────────────────── │  gcc / make  │
    └──────┬───────┘        scp BOAT.elf                  └──────────────┘
           │ USB
       ST-Link ──▶ 板子

**为什么不是 Tailscale 代替 SSH**：Tailscale 只负责"能通"（打洞、固定 100.x 地址、加密），
登录仍然是 OpenSSH。两台机器都不需要公网 IP、不需要端口映射。

---

## 一次性配置

### 1. 参考机（这台）

已经有现成脚本，**管理员权限**跑一次：

    powershell -ExecutionPolicy Bypass -File tools\migrate\ssh\Enable-BoatSshd.ps1

它会：装 OpenSSH Server（可选功能，失败回退到 Win32-OpenSSH）→ 备份并写 sshd_config
→ 生成主机密钥 → 建 authorized_keys 并收紧 ACL → **防火墙规则只放行 Tailscale 网卡地址**
→ 启动服务 + 开机自启 → 打印主机密钥指纹。

### 2. 小电脑：生成密钥

    powershell -ExecutionPolicy Bypass -File tools\migrate\ssh\New-BoatClientKey.ps1 -HostName 100.92.185.68

它会生成 \~/.ssh/boat_ed25519\、写好 \~/.ssh/config\ 的 \Host boat\ 块，并打印一行公钥。

### 3. 把公钥贴回参考机

两种都行：

- 把公钥发给参考机上的我 / 手工追加到 \C:\Users\admin\.ssh\authorized_keys\
- 或者在参考机重跑：\Enable-BoatSshd.ps1 -PublicKey "ssh-ed25519 AAAA... boat"\（会自动关掉密码登录）

### 4. 验证

    ssh boat "hostname"        # 小电脑上
    ssh -v boat                # 连不上时看这一步卡在哪

---

## 日常用法

### VS Code Remote-SSH

1. 装扩展 **Remote - SSH**（ms-vscode-remote.remote-ssh）
2. Ctrl+Shift+P → Remote-SSH: Connect to Host... → boat
3. 连上后 File > Open Folder → \E:\STM32\BOAT\
4. **重要**：在设置里加一条，否则每次连接都会问你远端是什么系统

       "remote.SSH.remotePlatform": { "boat": "windows" }

之后编辑、终端、调试都在参考机上跑，小电脑只负责显示。

### 编译在远端，烧录在本地

    # 小电脑上：让参考机编译 + 把 elf 拉回来
    powershell -ExecutionPolicy Bypass -File tools\migrate\ssh\fetch-elf.ps1 -Build

    # 本地烧录（ST-Link 插在小电脑上）
    powershell -ExecutionPolicy Bypass -File tools\migrate\dev.ps1 flash -Elf .\_remote\BOAT.elf

fetch-elf.ps1 默认从 \E:/STM32/BOAT\ 拉，参考机路径不同就加 \-RemoteRepo D:/xxx/BOAT\。

**断网了怎么办**：远端这条链路整体失效，直接回落 \dev.ps1 build\ + \dev.ps1 flash\ 本地编译烧录（这就是要准备离线包的原因）。

---

## 文件说明

| 文件 | 在哪跑 | 作用 |
|---|---|---|
| Enable-BoatSshd.ps1 | 参考机（管理员） | 装 + 配 sshd、防火墙、authorized_keys、打印指纹 |
| New-BoatClientKey.ps1 | 小电脑 | 生成 ed25519 密钥 + 写 ~/.ssh/config |
| Remote-Build.ps1 | 参考机（被 ssh 调用） | 用便携工具链编译 Debug/BOAT.elf |
| fetch-elf.ps1 | 小电脑 | 远程编译（可选）+ scp 拉回 elf/map |

---

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| ssh: connect to host ... port 22: Connection timed out | Tailscale 没通 / 防火墙没放行 | 先 tailscale ping lazy；再确认参考机上 Get-NetTCPConnection -LocalPort 22 -State Listen |
| Connection refused | sshd 没在跑 | Get-Service sshd，Start-Service sshd |
| Permission denied (publickey) | 公钥没落到文件里 / ACL 不对 | 看 \C:\Users\<user>\.ssh\authorized_keys\；icacls 只留本人 + SYSTEM + Administrators |
| 一直要密码 | 公钥没生效 | ssh -v boat 看有没有 Offering public key；注意 IdentitiesOnly yes 只用一个 key |
| 连上了但 make 找不到 | 非交互 shell 的 PATH 不同 | 用 Remote-Build.ps1（它自己 dot-source env.ps1），别直接 ssh 敲 make |
| VS Code 终端是 cmd 且很怪 | 默认 shell 没改 | New-ItemProperty HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -Value powershell.exe |
| 主机密钥变了（重装后） | host key 重新生成 | 小电脑上 ssh-keygen -R boat，然后核对新指纹 |

---

## 安全边界

- 防火墙规则带 \-LocalAddress <tailscale-ip>\，**只有 tailnet 内能碰到 22 端口**，公网扫不到。
- 给了公钥就关 PasswordAuthentication；没给之前保留密码登录作为兜底（只在 tailnet 内可达）。
- PermitRootLogin no、MaxAuthTries 4、LogLevel VERBOSE（日志在 \C:\ProgramData\ssh\logs\）。
- 换机器/换 tailnet 记得 ssh-keygen -R boat 并重跑一遍服务端脚本。
