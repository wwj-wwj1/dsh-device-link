<#
  把 EasyTier 注册成 Windows 服务（由 dsh-device-link 插件调用，也可以自己手动跑）。

  做的事：
    1. sc create / sc config：服务指向 "easytier-core.exe -c <配置文件>"
    2. 配「失败自动重启」策略（崩了 5 秒后自己回来）
    3. 给 core 程序和隧道端口加防火墙入站放行（手机才能连进来）
    4. 启动服务并回报状态

  需要管理员权限：不是管理员时会自己弹 UAC 再跑一遍。
  日志：%TEMP%\dsh-device-link-service.log
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$CorePath,
  [string]$ServiceName = 'EasyTierService',
  [int]$TunnelPort = 11010
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $env:TEMP 'dsh-device-link-service.log'

function Write-Log([string]$Text) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 } catch { }
  Write-Host $line
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$admin = Test-Admin
Write-Log ('start admin={0} service={1} core={2} config={3}' -f $admin, $ServiceName, $CorePath, $ConfigPath)

if (-not $admin) {
  Write-Log 'not elevated -> relaunch via UAC'
  $quoted = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}" -CorePath "{2}" -ServiceName {3} -TunnelPort {4}' -f `
    $PSCommandPath, $ConfigPath, $CorePath, $ServiceName, $TunnelPort
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $quoted -Wait
    Write-Log 'elevated run finished'
    exit 0
  } catch {
    Write-Log ('elevation failed: {0}' -f $_.Exception.Message)
    exit 2
  }
}

if (-not (Test-Path -LiteralPath $CorePath)) { Write-Log ('core not found: ' + $CorePath); exit 3 }
if (-not (Test-Path -LiteralPath $ConfigPath)) { Write-Log ('config not found: ' + $ConfigPath); exit 4 }

$sc = Join-Path $env:SystemRoot 'System32\sc.exe'
$binPath = '"{0}" -c "{1}"' -f $CorePath, $ConfigPath

& $sc query $ServiceName *> $null
$exists = ($LASTEXITCODE -eq 0)

if ($exists) {
  Write-Log 'service exists -> stop & rewrite binPath'
  & $sc stop $ServiceName *> $null
  Start-Sleep -Seconds 2
  $out = & $sc config $ServiceName binPath= $binPath start= demand 2>&1 | Out-String
  Write-Log ('sc config: ' + $out.Trim())
} else {
  Write-Log 'service absent -> create'
  $out = & $sc create $ServiceName binPath= $binPath start= demand DisplayName= 'EasyTier Device Link' 2>&1 | Out-String
  Write-Log ('sc create: ' + $out.Trim())
}

& $sc failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 *> $null
& $sc failureflag $ServiceName 1 *> $null
& $sc description $ServiceName 'EasyTier virtual network (managed by dsh-device-link)' *> $null
Write-Log 'recovery policy + description applied'

$programRule = 'EasyTier inbound (dsh-device-link)'
$portRule = 'EasyTier tunnel (dsh-device-link)'
try {
  if (-not (Get-NetFirewallRule -DisplayName $programRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $programRule -Direction Inbound -Action Allow -Program $CorePath -Profile Any | Out-Null
    Write-Log 'firewall: program rule added'
  } else {
    Write-Log 'firewall: program rule already present'
  }
  if (-not (Get-NetFirewallRule -DisplayName $portRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $portRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $TunnelPort -Profile Any | Out-Null
    New-NetFirewallRule -DisplayName $portRule -Direction Inbound -Action Allow -Protocol UDP -LocalPort $TunnelPort -Profile Any | Out-Null
    Write-Log 'firewall: port rules added'
  } else {
    Write-Log 'firewall: port rule already present'
  }
} catch {
  Write-Log ('firewall skipped: ' + $_.Exception.Message)
}

$startOut = & $sc start $ServiceName 2>&1 | Out-String
Write-Log ('sc start: ' + $startOut.Trim())
Start-Sleep -Seconds 3
$query = & $sc query $ServiceName 2>&1 | Out-String
Write-Log ('sc query: ' + ($query -replace '\s+', ' ').Trim())

if ($query -match 'RUNNING') { Write-Log 'DONE ok'; exit 0 }
Write-Log 'DONE but service is not RUNNING'
exit 1