# build-portable.ps1 - Build the CCursor portable offline package.
#
# What it does (in order):
#   1. Read version from installer/package.json
#   2. Back up current build artifacts (restored if the rebuild fails)
#   3. Rebuild vsix + CLI from current source (installer build:all)
#      -> installer/vsix/*.vsix + installer/dist/cli.cjs + installer/dist/models-catalog.json
#   4. Stage portable layout in dist-portable/ccursor-portable-<version>/
#      (portable-files/* + dist/ + vsix/ + node_modules/acorn + LICENSE + VERSION.txt)
#   5. Smoke-test the staged copy: node dist/cli.cjs status must run
#      (proves acorn resolves and the layout is intact on a "fresh" machine layout)
#   6. Zip it to dist-portable/ccursor-portable-<version>.zip
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
#   powershell -ExecutionPolicy Bypass -File .\build-portable.ps1 -SkipBuild   # repackage current dist/vsix only
param(
  [switch]$SkipBuild
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

$RepoRoot = $PSScriptRoot
if ($RepoRoot -eq $null -or $RepoRoot -eq "") {
  $RepoRoot = (Get-Location).Path
}
Write-Host "Repo root: $RepoRoot"

$InstallerDir = Join-Path $RepoRoot 'installer'
$TemplateDir = Join-Path $RepoRoot 'portable-files'
$OutputDir = Join-Path $RepoRoot 'dist-portable'

if (-not (Test-Path (Join-Path $TemplateDir 'install.ps1'))) { Fail "Missing template dir: $TemplateDir" }
if (-not (Test-Path (Join-Path $InstallerDir 'package.json'))) { Fail "Not found: $InstallerDir\package.json" }

# -- 1. Version --
$installerPackage = Get-Content (Join-Path $InstallerDir 'package.json') -Raw | ConvertFrom-Json
$PackageVersion = [string]$installerPackage.version
if ($PackageVersion -eq "") { Fail "Could not read version from installer/package.json" }
$PackageName = "ccursor-portable-$PackageVersion"
Write-Host "Package version: $PackageVersion"

# -- 2-3. Rebuild (with backup/restore safety) --
if ($SkipBuild) {
  Write-Step "Skipping rebuild (-SkipBuild), using current dist/vsix"
}
else {
  Write-Step "Backing up current build artifacts"
  $BackupDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ccursor-build-backup-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  $VsixBackupDir = Join-Path $BackupDir 'vsix'
  $DistBackupDir = Join-Path $BackupDir 'dist'
  if (Test-Path (Join-Path $InstallerDir 'vsix')) { Copy-Item (Join-Path $InstallerDir 'vsix') $VsixBackupDir -Recurse -Force }
  if (Test-Path (Join-Path $InstallerDir 'dist')) { Copy-Item (Join-Path $InstallerDir 'dist') $DistBackupDir -Recurse -Force }
  Write-Host "Backup: $BackupDir"

  Write-Step "Rebuilding vsix + CLI from current source (installer build:all)"
  Push-Location $InstallerDir
  try {
    npm run build:all
    if ($LASTEXITCODE -ne 0) { throw "installer build:all failed (exit $LASTEXITCODE)." }
  }
  catch {
    Pop-Location
    Write-WarnMsg ("Rebuild failed: {0}" -f $_)
    Write-WarnMsg "Restoring previous artifacts so the repo is left in a working state."
    if (Test-Path $VsixBackupDir) { Copy-Item (Join-Path $VsixBackupDir '*') (Join-Path $InstallerDir 'vsix') -Recurse -Force }
    if (Test-Path $DistBackupDir) { Copy-Item (Join-Path $DistBackupDir '*') (Join-Path $InstallerDir 'dist') -Recurse -Force }
    Fail "Aborted. Previous artifacts restored. Fix the build error and retry, or use -SkipBuild to package the previous build."
  }
  Pop-Location
  Write-Ok "Rebuild finished"
  Remove-Item $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
}

# -- Verify artifacts --
Write-Step "Verifying build artifacts"
$CliSource = Join-Path $InstallerDir 'dist\cli.cjs'
$CatalogSource = Join-Path $InstallerDir 'dist\models-catalog.json'
$AcornSource = Join-Path $InstallerDir 'node_modules\acorn'
if (-not (Test-Path $CliSource)) { Fail "Missing artifact: $CliSource" }
if (-not (Test-Path $CatalogSource)) { Fail "Missing artifact: $CatalogSource" }
if (-not (Test-Path (Join-Path $AcornSource 'package.json'))) { Fail "Missing runtime dep: $AcornSource (run npm install in installer/ first)" }
$VsixSources = @(Get-ChildItem (Join-Path $InstallerDir 'vsix\*.vsix') -ErrorAction SilentlyContinue)
if ($VsixSources.Count -eq 0) { Fail "No .vsix in installer\vsix\" }
if ($VsixSources.Count -gt 1) { Write-WarnMsg ("Multiple vsix files, packaging the newest: {0}" -f $VsixSources[0].Name) }
$VsixSource = $VsixSources | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Ok ("vsix: {0} ({1:0.0} MB)" -f $VsixSource.Name, ($VsixSource.Length / 1MB))

# -- 4. Stage portable layout --
Write-Step "Staging portable package"
$StageDir = Join-Path $OutputDir $PackageName
if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
Copy-Item (Join-Path $TemplateDir '*') $StageDir -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $StageDir 'dist') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir 'vsix') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir 'node_modules') -Force | Out-Null
Copy-Item $CliSource (Join-Path $StageDir 'dist\cli.cjs') -Force
Copy-Item $CatalogSource (Join-Path $StageDir 'dist\models-catalog.json') -Force
Copy-Item $VsixSource.FullName (Join-Path $StageDir ('vsix\' + $VsixSource.Name)) -Force
Copy-Item $AcornSource (Join-Path $StageDir 'node_modules\acorn') -Recurse -Force
$LicenseSource = Join-Path $RepoRoot 'LICENSE'
if (Test-Path $LicenseSource) { Copy-Item $LicenseSource (Join-Path $StageDir 'LICENSE') -Force }

$BuildStamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss') + ' UTC'
$VersionInfoLines = @(
  "CCursor portable package",
  "installer version : $PackageVersion",
  "vsix              : $($VsixSource.Name) ({0:0.0} MB)" -f ($VsixSource.Length / 1MB),
  "built from        : $RepoRoot",
  "built at          : $BuildStamp",
  "built with        : $(node --version) on $env:COMPUTERNAME"
)
$VersionInfoLines | Set-Content (Join-Path $StageDir 'VERSION.txt') -Encoding UTF8
Write-Ok "Staged: $StageDir"
Get-ChildItem $StageDir -Recurse -File | ForEach-Object {
  $relativePath = $_.FullName.Substring($StageDir.Length + 1)
  Write-Host ("  {0,8:0.0} MB  {1}" -f ($_.Length / 1MB), $relativePath)
}

# -- 5. Smoke test the staged copy (read-only: status never patches) --
Write-Step "Smoke-testing staged package (cli.cjs status)"
Push-Location $StageDir
try {
  node dist/cli.cjs status
  if ($LASTEXITCODE -ne 0) { Fail "Smoke test failed: staged cli.cjs status exited with $LASTEXITCODE." }
}
finally {
  Pop-Location
}
Write-Ok "Smoke test passed"

# -- 6. Zip --
Write-Step "Creating zip"
$ZipPath = Join-Path $OutputDir ("$PackageName.zip")
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $StageDir '*') -DestinationPath $ZipPath -CompressionLevel Optimal
$zipInfo = Get-Item $ZipPath
Write-Ok ("Created {0} ({1:0.0} MB)" -f $ZipPath, ($zipInfo.Length / 1MB))

Write-Host ""
Write-Ok "Done. Ship this file to the other machine:"
Write-Host "  $ZipPath"
Write-Host "On the target machine: unzip anywhere -> double-click install.bat -> restart Cursor."
