<#
.SYNOPSIS
  One-click VSIX builder for BurstCode and its local alerts companion.

.DESCRIPTION
  - Sets a local HTTP/HTTPS proxy (default 127.0.0.1:7890) so npm/vsce can
    reach the registry from China.
  - Bumps the patch version when -BumpVersion is supplied.
  - Keeps companion/package.json version in sync with package.json.
  - Runs the production esbuild bundle for both extensions.
  - Packages both VSIX files:
      * burstcode-<version>.vsix
      * burstcode-local-alerts-<version>.vsix

.PARAMETER Proxy
  HTTP(S) proxy URL. Pass empty string ("") to skip proxy. Default:
  http://127.0.0.1:7890.

.PARAMETER BumpVersion
  When set, bump package.json's patch version before packaging.

.PARAMETER SkipInstall
  Skip the "ensure @vscode/vsce is installed" check. Use when you know
  node_modules already has it (faster).

.EXAMPLE
  npm run pack
  powershell -File scripts/pack.ps1
  powershell -File scripts/pack.ps1 -Proxy "" -BumpVersion
#>
[CmdletBinding()]
param(
  [string]$Proxy = "http://127.0.0.1:7890",
  [switch]$BumpVersion,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Read-JsonFile([string]$Path) {
  $raw = [System.IO.File]::ReadAllText($Path)
  if ($null -eq $raw) { $raw = "" }
  return $raw | ConvertFrom-Json
}

function Write-JsonFile([string]$Path, $Value) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $json = $Value | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($Path, "$json`n", $utf8NoBom)
}

function Invoke-VscePackage([string]$WorkingDirectory, [string]$PackagePath, [string]$Label) {
  Write-Host "[pack] vsce package: $Label" -ForegroundColor Yellow
  Push-Location $WorkingDirectory
  try {
    & $script:VsceCmd package --no-dependencies --out $PackagePath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed for $Label." }
  }
  finally {
    Pop-Location
  }
}

# Move to repo root (the directory containing this script's parent).
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot
Write-Host "[pack] repo: $repoRoot" -ForegroundColor Cyan

# ---- proxy ---------------------------------------------------------------
if ($Proxy -and $Proxy.Trim().Length -gt 0) {
  $env:HTTP_PROXY  = $Proxy
  $env:HTTPS_PROXY = $Proxy
  Write-Host "[pack] proxy: $Proxy" -ForegroundColor DarkGray
} else {
  Write-Host "[pack] proxy: (none)" -ForegroundColor DarkGray
}

# ---- optional version bump ----------------------------------------------
if ($BumpVersion) {
  Write-Host "[pack] bumping patch version..." -ForegroundColor Yellow
  npm version patch --no-git-tag-version | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "npm version patch failed." }
}

# ---- sync companion version ---------------------------------------------
$repoRootStr = [string]$repoRoot
$mainPackagePath = [System.IO.Path]::Combine($repoRootStr, "package.json")
$companionPackagePath = [System.IO.Path]::Combine($repoRootStr, "companion", "package.json")
$mainPackage = Read-JsonFile $mainPackagePath
$version = [string]$mainPackage.version
if (-not $version) { throw "package.json version is empty." }

$companionPackage = Read-JsonFile $companionPackagePath
if ([string]$companionPackage.version -ne $version) {
  Write-Host "[pack] syncing companion version: $($companionPackage.version) -> $version" -ForegroundColor DarkGray
  $companionPackage.version = $version
  Write-JsonFile $companionPackagePath $companionPackage
}

# ---- ensure vsce is available -------------------------------------------
$script:VsceCmd = Join-Path $repoRoot "node_modules/.bin/vsce.cmd"
if (-not (Test-Path $script:VsceCmd)) {
  if ($SkipInstall) { throw "vsce missing under node_modules/.bin and -SkipInstall set." }
  Write-Host "[pack] installing @vscode/vsce..." -ForegroundColor Yellow
  $proxyArgs = @()
  if ($Proxy -and $Proxy.Trim().Length -gt 0) {
    $proxyArgs += "--proxy=$Proxy"
    $proxyArgs += "--https-proxy=$Proxy"
  }
  npm install --save-dev @vscode/vsce --no-audit --no-fund @proxyArgs | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "npm install @vscode/vsce failed." }
}

# ---- build ---------------------------------------------------------------
Write-Host "[pack] esbuild --production..." -ForegroundColor Yellow
npm run package | Out-Host
if ($LASTEXITCODE -ne 0) { throw "esbuild bundle failed." }

# ---- vsce package --------------------------------------------------------
# vsce 拒绝 README 里所有 <img src="*.svg">（除少数 badge 源），所以打包主扩展前
# 临时把 README 里指向 .svg 的 <img> 标签删掉，打完包再恢复。
$readmePath   = [System.IO.Path]::Combine($repoRootStr, "README.md")
$readmeBackup = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "burstcode-README.md.packbak")
$swappedReadme = $false
if ([System.IO.File]::Exists($readmePath)) {
  [System.IO.File]::Copy($readmePath, $readmeBackup, $true)
  $swappedReadme = $true
  $orig = [System.IO.File]::ReadAllText($readmePath)
  if ($null -eq $orig) { $orig = "" }
  $imgPattern = '<img\b[^>]*?src="[^"]*\.svg"[^>]*?>'
  $rxOpts = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Singleline
  $stripped = [System.Text.RegularExpressions.Regex]::Replace($orig, $imgPattern, '', $rxOpts)
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($readmePath, $stripped, $utf8NoBom)
  $removed = ($orig.Length - $stripped.Length)
  Write-Host "[pack] README.md: stripped SVG <img> tags ($removed chars)." -ForegroundColor DarkGray
}

$mainVsixName = "burstcode-$version.vsix"
$companionVsixName = "burstcode-local-alerts-$version.vsix"
$mainVsixPath = [System.IO.Path]::Combine($repoRootStr, $mainVsixName)
$companionVsixPath = [System.IO.Path]::Combine($repoRootStr, $companionVsixName)

try {
  Invoke-VscePackage -WorkingDirectory $repoRootStr -PackagePath $mainVsixPath -Label "BurstCode"
}
finally {
  if ($swappedReadme -and (Test-Path $readmeBackup)) {
    Move-Item -Path $readmeBackup -Destination $readmePath -Force
    Write-Host "[pack] README.md restored." -ForegroundColor DarkGray
  }
}

Invoke-VscePackage -WorkingDirectory ([System.IO.Path]::Combine($repoRootStr, "companion")) -PackagePath $companionVsixPath -Label "BurstCode Local Alerts Companion"

# ---- report produced VSIX files -----------------------------------------
$vsixFiles = @(
  Get-Item -Path $mainVsixPath -ErrorAction Stop
  Get-Item -Path $companionVsixPath -ErrorAction Stop
)

Write-Host ""
Write-Host "[pack] DONE" -ForegroundColor Green
foreach ($vsix in $vsixFiles) {
  $sizeKb = [math]::Round($vsix.Length / 1KB, 1)
  Write-Host "[pack]  ->  $($vsix.FullName)" -ForegroundColor Green
  Write-Host "[pack]      $sizeKb KB" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "Install both with:" -ForegroundColor Cyan
foreach ($vsix in $vsixFiles) {
  Write-Host "  code --install-extension `"$($vsix.FullName)`"" -ForegroundColor White
}
