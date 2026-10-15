# install-local.ps1 - One-click local build + install for CCursor (Windows PowerShell)
#
# What it does (in order):
#   1. Locate Cursor app dir (param > env > well-known paths, incl. D:\program\cursor)
#   1b. Stale-backup guard (Cursor self-updates leave old *.backup-byok-* behind;
#       restoring them would put old-version files over the new app -> corrupt dialog)
#   2. Verify node/pnpm, warn if Cursor is still running (file locks)
#   3. Build extension vsix  (installer build-vsix: pnpm run vsix + copy to installer/vsix/)
#   4. Build installer CLI   (installer build: node esbuild.js -> dist/cli.cjs)
#   5. Verify the fresh dist contains the Auto-review classifier-stub fix
#   6. Reinstall via local CLI (update when backups match current version,
#       fresh install when stale backups were cleaned, forces vsix copy)
#   7. Verify the installed extension.js contains the fix and is fresh
#   8. Print next steps (fully quit + reopen Cursor, then check Run Mode)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install-local.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-local.ps1 -CursorRoot 'D:\program\cursor\resources\app'
#   powershell -ExecutionPolicy Bypass -File .\install-local.ps1 -SkipBuild   # reinstall current build only
#
# Why not `_build_once.js`:
#   - hardcoded root path, breaks on any other machine
#   - runs `pnpm run vsix` but never copies Cursor++/*.vsix -> installer/vsix/,
#     so `npx @cometix/ccursor install` (remote npm package) or even the local
#     CLI keeps installing the stale vsix
#   - no verification that the build actually contains your changes
#   - no handling for custom Cursor paths like D:\program\cursor
#
param(
  [string]$CursorRoot = "",
  [switch]$SkipBuild,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-WarnMsg([string]$Message) {
  Write-Host "[!] $Message" -ForegroundColor Yellow
}

function Fail([string]$Message) {
  Write-Host "[X] $Message" -ForegroundColor Red
  exit 1
}

function Find-CursorAppRoot([string]$Preferred) {
  $candidates = @()
  if ($Preferred -ne "") { $candidates += $Preferred }
  $envRoot = $env:CCURSOR_CURSOR_ROOT
  if ($envRoot -ne $null -and $envRoot -ne "") { $candidates += $envRoot }
  # Custom location observed on this machine (not covered by installer detect.js)
  $candidates += 'D:\program\cursor\resources\app'
  $localAppData = $env:LOCALAPPDATA
  if ($localAppData -ne $null -and $localAppData -ne "") {
    $candidates += (Join-Path $localAppData 'Programs\cursor\resources\app')
    $candidates += (Join-Path $localAppData 'Programs\Cursor\resources\app')
  }
  $programFiles = $env:ProgramFiles
  if ($programFiles -ne $null -and $programFiles -ne "") {
    $candidates += (Join-Path $programFiles 'Cursor\resources\app')
  }
  $programFilesX86 = ${env:ProgramFiles(x86)}
  if ($programFilesX86 -ne $null -and $programFilesX86 -ne "") {
    $candidates += (Join-Path $programFilesX86 'Cursor\resources\app')
  }

  foreach ($root in $candidates) {
    if ($root -eq $null -or $root -eq "") { continue }
    $productJson = Join-Path $root 'product.json'
    $workbenchJs = Join-Path $root 'out\vs\workbench\workbench.desktop.main.js'
    if ((Test-Path $productJson) -and (Test-Path $workbenchJs)) {
      return $root
    }
  }
  return $null
}

$RepoRoot = $PSScriptRoot
if ($RepoRoot -eq $null -or $RepoRoot -eq "") {
  $RepoRoot = (Get-Location).Path
}
Write-Host "Repo root: $RepoRoot"

# ── 1. Locate Cursor ──────────────────────────────────────────────
Write-Step "Locating Cursor installation"
$AppRoot = Find-CursorAppRoot -Preferred $CursorRoot
if ($AppRoot -eq $null) {
  Fail "Cursor not found. Pass -CursorRoot 'D:\path\to\cursor\resources\app' or set CCURSOR_CURSOR_ROOT."
}
Write-Ok "Cursor app root: $AppRoot"
$InstalledExtensionJs = Join-Path $AppRoot 'extensions\cursor2plus\dist\extension.js'

function Get-JsonVersionField([string]$FilePath) {
  try {
    $parsedContent = Get-Content $FilePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($null -ne $parsedContent.version -and $parsedContent.version -ne "") {
      return [string]$parsedContent.version
    }
    return ""
  }
  catch {
    return ""
  }
}

$FreshInstallOnly = $false
Write-Step "Checking for stale backups from a previous Cursor version"
$PackageJsonPath = Join-Path $AppRoot 'package.json'
$ProductJsonPath = Join-Path $AppRoot 'product.json'
$CurrentPackageVersion = Get-JsonVersionField $PackageJsonPath
$CurrentProductVersion = Get-JsonVersionField $ProductJsonPath
Write-Host "Cursor package.json version: $CurrentPackageVersion"
Write-Host "Cursor product.json version: $CurrentProductVersion"
if (($CurrentPackageVersion -ne "") -and ($CurrentProductVersion -ne "") -and ($CurrentPackageVersion -ne $CurrentProductVersion)) {
  Fail ("Version skew detected: package.json=$CurrentPackageVersion but product.json=$CurrentProductVersion. " + "product.json is stale (a previous update restored a pre-upgrade backup after Cursor self-updated). " + "Do NOT run uninstall/install now - it cannot rebuild the new product.json. " + "Fix: reinstall official Cursor over D:\program\cursor, launch once, fully quit, delete *.backup-byok-* under resources/app, then re-run this script.")
}
$ProductBackupFiles = @(Get-ChildItem (Join-Path $AppRoot 'product.json.backup-byok-*') -ErrorAction SilentlyContinue)
$StaleBackupDetected = $false
foreach ($backupFile in $ProductBackupFiles) {
  $backupVersion = Get-JsonVersionField $backupFile.FullName
  if (($backupVersion -ne "") -and ($backupVersion -ne $CurrentProductVersion)) {
    Write-WarnMsg ("Stale backup: {0} (version {1} != current {2})" -f $backupFile.Name, $backupVersion, $CurrentProductVersion)
    $StaleBackupDetected = $true
  }
}
if ($StaleBackupDetected -eq $true) {
  Write-WarnMsg "Backups are from an older Cursor version (official updater replaced app files but left backups behind)."
  Write-WarnMsg "Running uninstall now would restore those old files over the new Cursor -> corrupt dialog."
  Write-Step "Removing stale backups, will run fresh install instead of update"
  $AllStaleBackups = @(Get-ChildItem $AppRoot -Recurse -Filter '*.backup-byok-*' -ErrorAction SilentlyContinue)
  foreach ($staleFile in $AllStaleBackups) {
    Remove-Item $staleFile.FullName -Force -ErrorAction Stop
    Write-Host ("deleted: {0}" -f $staleFile.FullName)
  }
  Write-Ok ("Removed {0} stale backup file(s)" -f $AllStaleBackups.Count)
  $FreshInstallOnly = $true
}
else {
  Write-Ok "No stale backups (or no backups at all)"
}

# ── 2. Prerequisites ──────────────────────────────────────────────
Write-Step "Checking prerequisites"
try { $nodeVersion = (node --version) 2>&1 } catch { Fail "node not found in PATH (need >= 18). Install Node.js first." }
Write-Host "node: $nodeVersion"
if ($SkipBuild -eq $false) {
  $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpmCmd -eq $null) {
    Fail "pnpm not found in PATH. Install it (npm i -g pnpm) or run with -SkipBuild to reinstall the current build."
  }
  Write-Host "pnpm: $($pnpmCmd.Source)"
}

$cursorProcs = Get-Process cursor -ErrorAction SilentlyContinue
if ($cursorProcs -ne $null) {
  Write-WarnMsg "Cursor is running ($(@($cursorProcs).Count) process(es)). Files under extensions\cursor2plus may be locked."
  Write-WarnMsg "Recommended: fully quit Cursor (not just reload window), then re-run this script."
  if ($Force -eq $false) {
    Fail "Aborted to avoid partial install. Quit Cursor and retry, or re-run with -Force to proceed anyway."
  }
  Write-WarnMsg "-Force given, proceeding while Cursor is running."
}
else {
  Write-Ok "Cursor is not running"
}

$ExtensionDir = Join-Path $RepoRoot 'Cursor++'
$InstallerDir = Join-Path $RepoRoot 'installer'
if (-not (Test-Path (Join-Path $ExtensionDir 'package.json'))) { Fail "Not found: $ExtensionDir\package.json" }
if (-not (Test-Path (Join-Path $InstallerDir 'package.json'))) { Fail "Not found: $InstallerDir\package.json" }

# Markers that prove the fresh build contains the Auto-review classifier-stub fix.
# These are runtime string literals (survive esbuild --production minify).
$FixMarkers = @(
  'availableModels (BYOK + classifier',
  'Auto-review classifier'
)

# ── 3-4. Build ────────────────────────────────────────────────────
if ($SkipBuild) {
  Write-Step "Skipping build (-SkipBuild)"
}
else {
  Write-Step "Building vsix + CLI (installer build:all)"
  Push-Location $InstallerDir
  try {
    # build:all = build-vsix (pnpm run vsix in Cursor++ + copy to installer/vsix/)
    #           + build      (node esbuild.js -> dist/cli.cjs)
    npm run build:all
    if ($LASTEXITCODE -ne 0) { Fail "installer build:all failed (exit $LASTEXITCODE)." }
  }
  finally {
    Pop-Location
  }
  Write-Ok "build:all finished"
}

# ── 5. Verify fresh build ─────────────────────────────────────────
Write-Step "Verifying fresh build contains the fix"
$FreshExtensionJs = Join-Path $ExtensionDir 'dist\extension.js'
if (-not (Test-Path $FreshExtensionJs)) { Fail "Missing build output: $FreshExtensionJs" }
foreach ($marker in $FixMarkers) {
  $hit = Select-String -Path $FreshExtensionJs -Pattern $marker -SimpleMatch -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit -eq $null) {
    Fail "Build verification failed: marker '$marker' not found in $FreshExtensionJs. Build is stale - check for build errors above."
  }
  Write-Ok "found marker: $marker"
}
$VsixFiles = @(Get-ChildItem (Join-Path $InstallerDir 'vsix\*.vsix') -ErrorAction SilentlyContinue)
if ($VsixFiles.Count -eq 0) { Fail "No .vsix in installer\vsix\. Build did not copy the artifact." }
foreach ($f in $VsixFiles) {
  Write-Host ("vsix: {0} ({1:0.0} MB, {2})" -f $f.FullName, ($f.Length / 1MB), $f.LastWriteTime)
}

# ── 6. Install via LOCAL cli (never npx remote) ───────────────────
if ($FreshInstallOnly -eq $true) {
  Write-Step "Installing via local CLI (fresh install, stale backups were cleaned)"
}
else {
  Write-Step "Installing via local CLI (update = uninstall + install)"
}
$CliPath = Join-Path $InstallerDir 'dist\cli.cjs'
if (-not (Test-Path $CliPath)) { Fail "Missing CLI: $CliPath" }
$env:CCURSOR_CURSOR_ROOT = $AppRoot
Write-Host "CCURSOR_CURSOR_ROOT=$AppRoot"
Push-Location $InstallerDir
try {
  if ($FreshInstallOnly -eq $true) {
    node dist/cli.cjs install
  }
  else {
    node dist/cli.cjs update
  }
  if ($LASTEXITCODE -ne 0) { Fail "local install failed (exit $LASTEXITCODE)." }
}
finally {
  Pop-Location
}
Write-Ok "local install finished"

# ── 7. Verify installed files ─────────────────────────────────────
Write-Step "Verifying installed extension"
if (-not (Test-Path $InstalledExtensionJs)) { Fail "Installed file missing: $InstalledExtensionJs" }
$installedInfo = Get-Item $InstalledExtensionJs
$ageMinutes = ((Get-Date) - $installedInfo.LastWriteTime).TotalMinutes
Write-Host ("installed: {0} ({1:0.0} MB, {2}, {3:0} min ago)" -f $installedInfo.FullName, ($installedInfo.Length / 1MB), $installedInfo.LastWriteTime, $ageMinutes)
if ($ageMinutes -gt 15) {
  Write-WarnMsg "Installed file looks stale (>15 min old). The installer may have skipped copying (Already fully installed?)."
}
foreach ($marker in $FixMarkers) {
  $hit = Select-String -Path $InstalledExtensionJs -Pattern $marker -SimpleMatch -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit -eq $null) {
    Fail "Install verification failed: marker '$marker' not found in installed extension.js. You are still running old code."
  }
  Write-Ok "installed marker: $marker"
}

# ── 8. Next steps ─────────────────────────────────────────────────
Write-Step "Done"
Write-Host "1. Fully QUIT Cursor (tray icon too), then reopen it. A window reload is not enough - AvailableModels is cached."
Write-Host "2. Keep BYOK ON, go to Settings > Agents > Approvals & Execution, check Run Mode."
Write-Host "   Auto-Review should now be selectable; Agent runs still use your providers.json models."
Write-Host "3. If it is still grey, run: node installer/dist/cli.cjs status"
Write-Host "   and send back the '[MODEL] availableModels (BYOK + classifier ...)' log line (classifierCount)."
Write-Host ""
Write-Ok "All checks passed."
