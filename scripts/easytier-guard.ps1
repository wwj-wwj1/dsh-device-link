<#
    EasyTier 组网服务「失败自愈」策略开关
    ------------------------------------------------------------
    背景：easytier-core 收到 SCM 停止请求时以非 0 退出码结束，
          于是 Windows 按服务的恢复策略（安装脚本设的 restart/5000 ×3）
          在 5 秒后把它拉回来 —— 这就是「关组网关不掉」的原因。

    -Action Clear     清空失败自愈动作 → 之后关闭组网能真正停住（一次性，需管理员）
    -Action Restore   还原成安装脚本的原始策略（RESTART ×3，5 秒延迟，24h 清零）
    -Action Status    只读查看（不需要管理员）

    只动 Windows 服务的恢复策略，不改 EasyTier 的任何配置（easytier.toml 原样）。
    每次运行都会往%TEMP%\easytier-guard.log 追加一行记录，便于排查。
#>
param(
    [ValidateSet('Clear', 'Restore', 'Status')]
    [string]$Action = 'Status',
    [string]$Service = 'EasyTierService'
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936) } catch { }

$SVC = if ($Service) { $Service } else { 'EasyTierService' }
$here = $PSCommandPath
if (-not $here) { $here = $MyInvocation.MyCommand.Definition }
$logDir = if ($env:TEMP) { $env:TEMP } else { Split-Path -Parent $here }
$logPath = Join-Path $logDir 'easytier-guard.log'

function Write-Log([string]$text) {
    try {
        $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    } catch { }
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Head([string]$text) {
    Write-Host ''
    Write-Host ('  ' + ('=' * 58)) -ForegroundColor DarkGray
    Write-Host ('    ' + $text) -ForegroundColor Cyan
    Write-Host ('  ' + ('=' * 58)) -ForegroundColor DarkGray
    Write-Host ''
}

$sc = Join-Path $env:SystemRoot 'System32\sc.exe'
if (-not (Test-Path $sc)) { $sc = 'sc.exe' }

# sc qfailure 的键名是 ASCII，但动作文本会被本地化（中文系统显示「重新启动 -- 延迟 = 5000 毫秒。」），
# 所以按「键行 / 续行」的结构数动作条数，不依赖 RESTART 这类关键字。
function Get-PolicyActions {
    $raw = (& $sc qfailure $SVC | Out-String)
    $lines = $raw -split "`r?`n"
    $idx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match 'FAILURE_ACTIONS') { $idx = $i; break }
    }
    $actions = @()
    if ($idx -ge 0) {
        $pair = $lines[$idx] -split ':', 2
        if ($pair.Count -gt 1 -and $pair[1].Trim()) { $actions += $pair[1].Trim() }
        for ($j = $idx + 1; $j -lt $lines.Count; $j++) {
            $line = $lines[$j]
            if (-not $line.Trim()) { continue }
            if ($line -match '^\s*[A-Z_]{3,}\s*:') { break }
            $actions += $line.Trim()
        }
    }
    return $actions
}

function Show-Policy {
    & $sc qfailure $SVC | Out-Host
    Write-Host ''
    $actions = @(Get-PolicyActions)
    if ($actions.Count -gt 0) {
        Write-Host ('  => 当前有 ' + $actions.Count + ' 条失败自愈动作：停服会被系统在 5 秒后拉起。') -ForegroundColor Yellow
        return $true
    }
    Write-Host '  => 当前没有失败自愈动作：停服可以真正停住。' -ForegroundColor Green
    return $false
}

Write-Log ('start action=' + $Action + ' admin=' + (Test-Admin) + ' pid=' + $PID)

# ---- 没管理员就弹一次 UAC 重新以管理员跑（只对会改配置的动作），并等它结束 ----
if ($Action -ne 'Status' -and -not (Test-Admin)) {
    Write-Head '需要管理员权限'
    Write-Host '  改服务的恢复策略需要管理员。已弹出 UAC 确认框，请点「是」。' -ForegroundColor Yellow
    Write-Host ''
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $here + '"'), '-Action', $Action)
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -Wait
        Write-Log 'elevated child finished'
        Write-Host ''
        Write-Host '  管理员窗口已结束，下面是当前状态：' -ForegroundColor DarkGray
        [void](Show-Policy)
    }
    catch {
        Write-Log ('elevation failed: ' + $_.Exception.Message)
        Write-Host ('  提权失败或被取消：' + $_.Exception.Message) -ForegroundColor Red
        Write-Host '  请右键这个 .cmd →「以管理员身份运行」再试一次。' -ForegroundColor Yellow
    }
    Write-Host ''
    Read-Host '按回车关闭'
    exit 0
}

switch ($Action) {
    'Status' {
        Write-Head 'EasyTier 组网服务 —— 恢复策略现状'
        $q = (& $sc query $SVC | Out-String)
        if ($q -match '1060') { Write-Host '  服务未安装（EasyTierService 不存在）。' -ForegroundColor Red; break }
        [void](Show-Policy)
        Write-Host ''
    }

    'Clear' {
        Write-Head '清空失败自愈动作（让关闭组网能真停住）'
        [void](Show-Policy)
        Write-Host ''
        Write-Host '  正在清空 ...' -ForegroundColor DarkGray
        # 交给 cmd 拼参数，避开 PowerShell 传空字符串给原生 exe 的坑
        $cmdLine = 'sc failure ' + $SVC + ' reset= 0 actions= ""'
        $out = cmd.exe /c $cmdLine 2>&1 | Out-String
        Write-Log ('clear exit=' + $LASTEXITCODE + ' :: ' + ($out -replace "`r?`n", ' | '))
        Write-Host ''
        Write-Host '  修改后：' -ForegroundColor DarkGray
        $still = Show-Policy
        Write-Log ('clear result still_protected=' + $still)
        Write-Host ''
        if ($still) {
            Write-Host '  [X] 没清掉。sc 的返回：' -ForegroundColor Red
            Write-Host $out -ForegroundColor DarkGray
            Write-Host '  请确认这个窗口标题带「管理员」，或改用「以管理员身份运行」。' -ForegroundColor Yellow
        } else {
            Write-Host '  [OK] 完成。现在到 DSH 左下角 WiFi 图标里关「组网互联」，' -ForegroundColor Green
            Write-Host '       EasyTier 服务会真正停在 STOPPED，虚拟网卡和 11010 端口都会释放。' -ForegroundColor Green
            Write-Host ''
            Write-Host '  注意：自愈动作清空后，EasyTier 崩溃也不会自动重启' -ForegroundColor Yellow
            Write-Host '        （在插件里关一下再开「组网互联」就等于重启）。' -ForegroundColor Yellow
            Write-Host '  想还原原来的自愈策略：运行同目录的 EasyTier-恢复原策略.cmd' -ForegroundColor Yellow
        }
        Write-Host ''
    }

    'Restore' {
        Write-Head '还原失败自愈策略（恢复成 EasyTier 安装脚本的原样）'
        Write-Host '  RESTART x3，每次延迟 5000ms，RESET_PERIOD 86400s' -ForegroundColor DarkGray
        Write-Host ''
        & $sc failure $SVC reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
        & $sc failureflag $SVC 1 | Out-Null
        Write-Log ('restore exit=' + $LASTEXITCODE)
        Write-Host '  修改后：' -ForegroundColor DarkGray
        [void](Show-Policy)
        Write-Host ''
    }
}

Read-Host '按回车关闭'