CCursor portable offline package / CCursor 离线安装包
=====================================================
See VERSION.txt for the packaged version and build date.
具体打包版本和构建日期见 VERSION.txt。

1. Requirements / 准备工作
--------------------------
- Target machine needs: Cursor IDE + Node.js >= 18.
  目标电脑只需要: 装好 Cursor + Node.js 18 或更新。
  Node.js 下载: https://nodejs.org/ (LTS 即可, 装完重新打开终端)
- This package is fully offline: no npm / network needed during install.
  本包是离线包: 安装过程不需要联网、不需要 npm。
- API keys are NOT included: after installing, configure your own
  providers in the Cursor++ sidebar, or copy over ~/.ccursor/providers.json
  from the old machine.
  API Key 不会跟着包走: 装完后在 Cursor++ 侧边栏配自己的 Key,
  或者把旧电脑 ~/.ccursor/providers.json 拷过去。

2. Install / 安装 (Windows)
----------------------------
1) Unzip this package anywhere. / 解压到任意目录。
2) Double-click install.bat. / 双击 install.bat。
3) If Cursor is open, quit it fully first (not just reload window).
   如果 Cursor 开着, 先彻底退出 (不只是重载窗口)。
4) After install, reopen Cursor, open the Cursor++ sidebar panel,
   configure providers / API keys.
   装完重开 Cursor, 打开 Cursor++ 侧边栏配服务商 / Key。

3. Install / 安装 (macOS / Linux)
----------------------------------
  tar/unzip, then: / 解压后执行:
    chmod +x install.sh
    ./install.sh

4. Custom Cursor path / Cursor 装在自定义路径
----------------------------------------------
Windows:
  powershell -ExecutionPolicy Bypass -File install.ps1 -CursorRoot "X:\path\to\cursor\resources\app"
macOS / Linux:
  ./install.sh --cursor-root /path/to/cursor/resources/app
(Or set the CCURSOR_CURSOR_ROOT environment variable. / 或设置环境变量 CCURSOR_CURSOR_ROOT。)

5. Re-run after every Cursor update / Cursor 更新后重装
--------------------------------------------------------
Cursor updates overwrite the patched files. Just run install.bat
(or ./install.sh) again, then restart Cursor.
Cursor 每次更新都会覆盖补丁, 再双击一次 install.bat (或 ./install.sh),
重启 Cursor 即可。如需强制重装: install.ps1 -Reinstall / ./install.sh --reinstall。

6. Status / Uninstall / 状态检查与卸载
---------------------------------------
Windows (PowerShell):
  powershell -ExecutionPolicy Bypass -File install.ps1 -Status
  powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
macOS / Linux:
  ./install.sh --status
  ./install.sh --uninstall

7. Package contents / 包内容
-----------------------------
  install.bat / install.ps1   Windows one-click installer / Windows 一键安装
  install.sh                  macOS / Linux one-click installer
  dist/cli.cjs                Bundled installer CLI (offline)
  dist/models-catalog.json    Model catalog defaults
  vsix/*.vsix                 Cursor++ extension package
  node_modules/acorn          Runtime dependency of cli.cjs
  VERSION.txt                 Packaged version info (generated at build time)
  README.txt                  This file / 本文件

Rebuild this package after code changes: / 改完代码重新打包:
  powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
