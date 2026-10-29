# install.ps1 - CCursor portable one-click installer (Windows PowerShell)
#
# The whole package is offline: dist/cli.cjs + dist/models-catalog.json +
# vsix/*.vsix + node_modules/acorn ship in this folder, no npm/network needed.
# Only requirement on the target machine: Node.js >= 18 and Cursor IDE.
#
# Usage:
#   Double-click install.bat, or run one of:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Reinstall
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -CursorRoot 'D:\custom\cursor\resources\app'
param(
  [string]$CursorRoot = "",
  [switch]$Reinstall,
  [switch]$Uninstall,
  [switch]$Status,
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
  $userProfile = [Environment]::GetFolderPath('UserProfile')
  if ($userProfile -ne $null -and $userProfile -ne "") {
    $candidates += (Join-Path $userProfile 'scoop\apps\cursor\current\resources\app')
  }
  foreach ($root in $candidates) {
    if ([string]::IsNullOrEmpty($root)) { continue }
    $productJson = Join-Path $root 'product.json'
    $workbenchJs = Join-Path $root 'out\vs\workbench\workbench.desktop.main.js'
    if ((Test-Path $productJson) -and (Test-Path $workbenchJs)) {
      return $root
    }
  }
  return $null
}

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

$PackageRoot = $PSScriptRoot
if ($PackageRoot -eq $null -or $PackageRoot -eq "") {
  $PackageRoot = (Get-Location).Path
}
Write-Host "Package: $PackageRoot"

# -- 1. Verify package contents (catch a broken/incomplete unzip) --
Write-Step "Verifying package contents"
$CliPath = Join-Path $PackageRoot 'dist\cli.cjs'
$CatalogPath = Join-Path $PackageRoot 'dist\models-catalog.json'
$AcornPath = Join-Path $PackageRoot 'node_modules\acorn\package.json'
if (-not (Test-Path $CliPath)) { Fail "Missing dist\cli.cjs - the zip was not fully extracted. Re-extract and retry." }
if (-not (Test-Path $CatalogPath)) { Write-WarnMsg "dist\models-catalog.json is missing - defaults release will skip the model catalog." }
if (-not (Test-Path $AcornPath)) { Fail "Missing node_modules\acorn - the zip was not fully extracted. Re-extract and retry." }
$VsixFiles = @(Get-ChildItem (Join-Path $PackageRoot 'vsix\*.vsix') -ErrorAction SilentlyContinue)
if ($VsixFiles.Count -eq 0) { Fail "No .vsix found under vsix\ - the zip was not fully extracted. Re-extract and retry." }
Write-Ok "cli.cjs + vsix ($($VsixFiles[0].Name), $([math]::Round($VsixFiles[0].Length / 1MB, 1)) MB) + acorn runtime present"

# -- 2. Node.js prerequisite --
Write-Step "Checking Node.js"
try { $nodeVersionOutput = (node --version) 2>&1 } catch { Fail "Node.js not found in PATH (need >= 18). Install Node.js from https://nodejs.org/ first." }
Write-Host "node: $nodeVersionOutput"
if ($nodeVersionOutput -match '^v(\d+)\.') {
  if ([int]$Matches[1] -lt 18) { Fail "Node.js $nodeVersionOutput is too old (need >= 18). Upgrade Node.js first." }
}
Write-Ok "Node.js OK"

# -- 3. Locate Cursor --
Write-Step "Locating Cursor installation"
$AppRoot = Find-CursorAppRoot -Preferred $CursorRoot
if ($AppRoot -eq $null) {
  Fail "Cursor not found. If Cursor is installed in a custom path, re-run with -CursorRoot 'X:\path\to\cursor\resources\app' or set the CCURSOR_CURSOR_ROOT environment variable."
}
Write-Ok "Cursor app root: $AppRoot"

# -- 4. Stale-backup guard (Cursor self-updates leave old *.backup-byok-* behind;
#      restoring them would put old-version files over the new app) --
if (-not $Uninstall -and -not $Status) {
  Write-Step "Checking for stale backups from a previous Cursor version"
  $CurrentProductVersion = Get-JsonVersionField (Join-Path $AppRoot 'product.json')
  Write-Host "Cursor product.json version: $CurrentProductVersion"
  $ProductBackupFiles = @(Get-ChildItem (Join-Path $AppRoot 'product.json.backup-byok-*') -ErrorAction SilentlyContinue)
  $staleBackupDetected = $false
  foreach ($backupFile in $ProductBackupFiles) {
    $backupVersion = Get-JsonVersionField $backupFile.FullName
    if (($backupVersion -ne "") -and ($CurrentProductVersion -ne "") -and ($backupVersion -ne $CurrentProductVersion)) {
      Write-WarnMsg ("Stale backup: {0} (version {1} != current {2})" -f $backupFile.Name, $backupVersion, $CurrentProductVersion)
      $staleBackupDetected = $true
    }
  }
  if ($staleBackupDetected) {
    Write-WarnMsg "Removing stale backups so the installer starts from a clean state."
    $allStaleBackups = @(Get-ChildItem $AppRoot -Recurse -Filter '*.backup-byok-*' -ErrorAction SilentlyContinue)
    foreach ($staleFile in $allStaleBackups) {
      Remove-Item $staleFile.FullName -Force -ErrorAction Stop
      Write-Host ("deleted: {0}" -f $staleFile.FullName)
    }
    Write-Ok ("Removed {0} stale backup file(s)" -f $allStaleBackups.Count)
  }
  else {
    Write-Ok "No stale backups"
  }
}

# -- 5. Cursor running? Files under extensions\cursor2plus may be locked --
$cursorProcesses = Get-Process cursor -ErrorAction SilentlyContinue
if (($cursorProcesses -ne $null) -and (-not $Status)) {
  Write-WarnMsg "Cursor is running ($(@($cursorProcesses).Count) process(es)). Patched files may be locked."
  Write-WarnMsg "Recommended: fully quit Cursor (not just reload window) before installing."
  if ($Force -eq $false) {
    Fail "Aborted to avoid a partial install. Quit Cursor and retry, or re-run with -Force to proceed anyway."
  }
  Write-WarnMsg "-Force given, proceeding while Cursor is running."
}
elseif ($cursorProcesses -eq $null) {
  Write-Ok "Cursor is not running"
}
# NOTE: -Status while Cursor is running prints nothing here on purpose;
# status is read-only and safe to run against a live Cursor.

# -- 6. Run the bundled CLI (offline, no npm/network) --
if ($CursorRoot -ne "") { $env:CCURSOR_CURSOR_ROOT = $AppRoot }
elseif ($env:CCURSOR_CURSOR_ROOT -eq $null -or $env:CCURSOR_CURSOR_ROOT -eq "") { $env:CCURSOR_CURSOR_ROOT = $AppRoot }
Write-Host "CCURSOR_CURSOR_ROOT=$AppRoot"
Push-Location $PackageRoot
try {
  if ($Uninstall) {
    Write-Step "Uninstalling via bundled CLI"
    node dist/cli.cjs uninstall
    if ($LASTEXITCODE -ne 0) { Fail "Uninstall failed (exit $LASTEXITCODE)." }
  }
  elseif ($Status) {
    Write-Step "Checking status via bundled CLI"
    node dist/cli.cjs status
    if ($LASTEXITCODE -ne 0) { Fail "Status check failed (exit $LASTEXITCODE)." }
  }
  elseif ($Reinstall) {
    Write-Step "Reinstalling via bundled CLI (uninstall + install)"
    node dist/cli.cjs update
    if ($LASTEXITCODE -ne 0) { Fail "Reinstall failed (exit $LASTEXITCODE)." }
  }
  else {
    Write-Step "Installing via bundled CLI"
    node dist/cli.cjs install
    if ($LASTEXITCODE -ne 0) { Fail "Install failed (exit $LASTEXITCODE)." }
  }
}
finally {
  Pop-Location
}
Write-Ok "CLI finished"

# -- 7. Verify + next steps --
if (-not $Uninstall) {
  Write-Step "Verifying installation"
  Push-Location $PackageRoot
  try {
    node dist/cli.cjs status
  }
  finally {
    Pop-Location
  }
  Write-Host ""
  Write-Ok "Done. Next steps:"
  Write-Host "  1. Fully quit Cursor if it is still open, then reopen it."
  Write-Host "  2. Open the Cursor++ sidebar panel and configure your providers / API keys (~/.ccursor/providers.json)."
  Write-Host "  3. After every Cursor update, re-run install.bat (updates overwrite the patched files)."
}
else {
 Write-Host ""
 Write-Ok "Uninstalled. Restart Cursor for changes to take effect."
}
