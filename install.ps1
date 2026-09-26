# Installs usage-stats on native Windows: Bun (if missing), the project
# dependencies, and a `usage-stats` command on the user PATH.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Bun ...'
  powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex'
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}

Write-Host 'Installing dependencies ...'
Push-Location $root
bun install --frozen-lockfile --production --omit=peer
Pop-Location

$binDir = Join-Path $env:USERPROFILE '.local\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Set-Content -Path (Join-Path $binDir 'usage-stats.cmd') -Value "@bun `"$root\src\main.tsx`" %*"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
}

Write-Host "`nDone. Open a new terminal and run: usage-stats"
