<#
.SYNOPSIS
  One-click VSIX builder for BurstCode.

.DESCRIPTION
  - Sets a local HTTP/HTTPS proxy (default 127.0.0.1:7890) so npm/vsce can
    reach the registry from China.
  - Bumps the patch version when -BumpVersion is supplied.
  - Runs the production esbuild bundle, then `vsce package`.
  - Drops the resulting *.vsix in the repo root and prints the path.

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

# ---- ensure vsce is available -------------------------------------------
$vsceCmd = Join-Path $repoRoot "node_modules/.bin/vsce.cmd"
if (-not (Test-Path $vsceCmd)) {
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
# vsce 拒绝 README 里所有 <img src="*.svg">（除少数 badge 源），所以打包前
# 临时把 README 里指向 .svg 的 <img> 标签删掉，打完包再恢复。
$repoRootStr  = [string]$repoRoot
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

try {
  Write-Host "[pack] vsce package..." -ForegroundColor Yellow
  & $vsceCmd package --no-dependencies --allow-missing-repository --skip-license | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "vsce package failed." }
}
finally {
  if ($swappedReadme -and (Test-Path $readmeBackup)) {
    Move-Item -Path $readmeBackup -Destination $readmePath -Force
    Write-Host "[pack] README.md restored." -ForegroundColor DarkGray
  }
}

# ---- report newest .vsix -------------------------------------------------
$vsix = Get-ChildItem -Path $repoRoot -Filter "*.vsix" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $vsix) { throw "No .vsix produced." }

Write-Host ""
Write-Host "[pack] DONE  ->  $($vsix.FullName)" -ForegroundColor Green
$sizeKb = [math]::Round($vsix.Length / 1KB, 1)
Write-Host "[pack]        $sizeKb KB" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Install with:" -ForegroundColor Cyan
Write-Host "  code --install-extension `"$($vsix.FullName)`"" -ForegroundColor White
