/**
 * dsh-device-link —— 左下角「设备互联」开关（host 半边）
 *
 * 职责：给浏览器半边提供两个端点
 *   GET  /api/device-link/status.json   读三路通道的真实状态
 *   POST /api/device-link/toggle.json   开/关某一路通道
 *
 * 三路通道的含义：
 *   master  互联总闸：关掉 = 两个对外网关全停，手机进不来；开启 = 按下面两路放开
 *   lan     局域网互联：在本机 0.0.0.0:lanPort 起网关，同 WiFi 的手机直连
 *   mesh    组网互联：起停 EasyTier 服务 + 在虚拟网卡 IP 上起网关（可选能力，没装就置灰）
 *
 * 可移植性约定（相对本机 beta 版做的改造）：
 *   - 网关脚本随包分发（lib/gate.cjs），不再依赖工作区里的外部路径。
 *   - EasyTier 的服务名与虚拟 IP 都自动探测，探测不到就不显示这个能力，而不是报错。
 *   - 端口被别的程序占着时自动顺延，不用用户去猜哪个端口冲突了。
 *   - 开关状态落盘，DSH 下次启动自动恢复。
 *
 * 安全边界：网关靠 ~/.dsh/.credentials.yaml 里的会话密钥自签 Cookie，任何能连上这个端口的人
 * 等于拿到完整 DSH 权限。所以默认只在用户主动开启时监听，并且前端/README 都提示“只在你信任的网络里开”。
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dgram from 'node:dgram'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLED_GATE = path.join(PKG_ROOT, 'lib', 'gate.cjs')
const DEFAULT_STATE_PATH = path.join(os.homedir(), '.dsh', 'device-link.state.json')

/** 常见的 EasyTier 服务名，先按这个顺序探一遍，省得每次都全量扫服务。 */
const KNOWN_SERVICES = ['EasyTierService', 'EasyTier', 'easytier']
/**
 * 公共汇合点（社区共享节点）。
 *
 * 用途只有一个：让两台设备「发现」彼此。握手成功后数据走 P2P 直连，不经过这些节点。
 * 这里只有公开的中转地址，**不含任何人的网络名 / 网络密码 / 虚拟 IP**；
 * 它们随时可能失效，用户可以按自己的情况替换（配置项 meetPeers）。
 */
const DEFAULT_PEERS = [
  'tcp://sh.vomiku.com:7910',
  'tcp://js.629957.xyz:11012',
  'tcp://47.92.208.217:11010',
  'tcp://et.lctn.cc.cd:6377',
  'udp://et.lctn.cc.cd:6161',
  'tcp://47.103.35.100:11010',
  'tcp://38.147.105.178:11010',
]

const INSTALL_URL = 'https://github.com/EasyTier/EasyTier/releases/latest'

const DEFAULTS = {
  lanHost: '0.0.0.0',
  lanPort: 8900,
  // 端口被占时最多顺延几个（0 = 不顺延，直接用报错的方式告诉用户）
  portRetry: 5,
  meshPort: 8899,
  // 留空 = 自动探测（从 EasyTier 虚拟网卡上读 IPv4），也可以由用户显式指定
  meshIp: '',
  meshHost: '',
  serviceName: '',
  // 留空 = 用随包分发的 lib/gate.cjs
  gateScript: '',
  // 留空 = 自动挑一个「Windows 防火墙放行过入站」的 node.exe
  nodePath: '',
  // EasyTier 节点发现/数据传输端口，用来粗略估计「组网里有几个对端」
  tunnelPort: 11010,
  // DSH 重启后是否恢复上次的开关状态
  restoreState: true,
  statePath: '',
  // —— EasyTier 安装 / 组网配置向导 ——
  // 未安装时用 winget 一键装（没有 winget 就只给下载链接）
  wingetId: 'EasyTier.EasyTier',
  installUrl: INSTALL_URL,
  // 显式指定 easytier-core.exe（空 = 自动搜常见安装目录和 winget 包目录）
  corePath: '',
  // 生成的 easytier.toml 放哪（空 = %LOCALAPPDATA%\dsh-device-link\easytier.toml）
  configPath: '',
  // 生成配置时写进去的公共汇合点
  meetPeers: DEFAULT_PEERS,
}

const MESH_UNSUPPORTED = '仅支持 Windows（依赖 sc.exe 管理 EasyTier 服务）'

/** 单次命令执行的统一包装：永远 resolve，不抛。 */
function run(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
    })
  })
}

/**
 * 挑一个「Windows 防火墙允许入站」的 node.exe 来跑网关。
 *
 * 系统里 node.exe 的入站放行是按**程序路径**登记的，而且还分网络配置文件（专用/公用）：
 * 以太网被 Windows 判成「公用网络」时，只有登记过 Public 放行的那个 node.exe 才收得到
 * 手机这类外部主机的连接（本机实测：`C:\Program Files\nodejs\node.exe` 只有 Private 放行，
 * 另一个自带 node 才有 Public 放行）。所以这里按「已知可用的候选」排序，取第一个存在的；
 * 真挑错了，用户还可以用配置里的 nodePath 显式指定。
 */
function nodeCandidates(cfg) {
  const list = []
  if (typeof cfg.nodePath === 'string' && cfg.nodePath) list.push(cfg.nodePath)
  // Electron 自带的 node：process.execPath 加 ELECTRON_RUN_AS_NODE 就能当 node 用
  if (process.versions.electron) list.push(process.execPath)
  try {
    const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions')
    if (fs.existsSync(base)) {
      for (const dir of fs.readdirSync(base).sort().reverse()) list.push(path.join(base, dir, 'node.exe'))
    }
  } catch {
    // 扫不到就算了，后面还有 Program Files 兜底
  }
  list.push('C:\\Program Files\\nodejs\\node.exe')
  const seen = new Set()
  return list.filter((item) => {
    const key = item.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    try {
      return fs.existsSync(item)
    } catch {
      return false
    }
  })
}

/** 本机对外的局域网 IPv4（用 UDP connect 取，不发包）。 */
function primaryLanIp() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { socket.close() } catch { /* 已经关了 */ }
      resolve(value)
    }
    try {
      socket.connect(53, '223.5.5.5', () => {
        try { done(socket.address().address) } catch { done(null) }
      })
      socket.on('error', () => done(null))
      setTimeout(() => done(null), 800)
    } catch {
      done(null)
    }
  })
}

/** netstat 里占着「某个监听地址 + 端口」的 LISTENING 进程号。 */
async function pidOnPort(exec, host, port) {
  if (process.platform !== 'win32') return null
  const result = await exec('netstat.exe', ['-ano', '-p', 'TCP'])
  if (!result.ok) return null
  // 必须连监听地址一起比对：0.0.0.0 上的监听和某个具体 IP 上的监听是两个不同的 socket，
  // 只按端口匹配会认错进程（曾经差点因此去 kill 别人的进程）。
  const escaped = String(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*TCP\\s+${escaped}:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'm')
  const matched = result.stdout.match(pattern)
  return matched ? Number(matched[1]) : null
}

/** EasyTier 数据传输端口上已建立的连接数，作为「组网活着」的粗指标。 */
async function peerCount(exec, tunnelPort) {
  if (process.platform !== 'win32') return 0
  const result = await exec('netstat.exe', ['-ano', '-p', 'TCP'])
  if (!result.ok) return 0
  let count = 0
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.includes(`:${tunnelPort}`)) continue
    if (!/ESTABLISHED/i.test(line)) continue
    count += 1
  }
  return count
}

/** 枚举本机 IPv4（含网卡名），用于识别 EasyTier 虚拟网卡。 */
function ipv4Interfaces() {
  const list = []
  try {
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const addr of addresses ?? []) {
        if (addr.family !== 'IPv4') continue
        list.push({ name, address: addr.address, internal: Boolean(addr.internal) })
      }
    }
  } catch {
    // 枚举失败按空处理
  }
  return list
}

/** EasyTier 的虚拟网卡名形如 `et_11_ak0m`（每次启动随机后缀），按名字认即可。 */
function isEasyTierAdapterName(name) {
  return /^et_\d+/i.test(name) || /easytier|tier_/i.test(name)
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  // 测试钩子：沙箱里 execFile 的管道 stdio 会被拒（EPERM），冒烟测试可注入一个
  // 走「文件 FD + 纯读」的命令执行器；生产环境永远走默认实现。
  const runCommand = typeof cfg.runCommand === 'function' ? cfg.runCommand : run
  const log = (level, message) => {
    try {
      const fn = ctx?.logger?.[level] ?? ctx?.logger?.info
      if (typeof fn === 'function') fn.call(ctx.logger, `[device-link] ${message}`)
      else console.log(`[device-link] ${message}`)
    } catch { /* 日志失败不影响功能 */ }
  }
  const isWindows = process.platform === 'win32'

  /** 本插件拉起的网关进程：key = 'lan' | 'mesh'，值是 { child, host, port }。 */
  const gates = new Map()
  /** 正在切换中的开关，避免连点打架。 */
  const busy = new Set()
  /**
   * 三个开关的「意图」。落盘只认它，不认网关进程是否还活着——
   * 否则插件被卸载/停用时进程先被杀掉，落盘的就会是「全关」，重启后再也恢复不回来。
   */
  const desired = { lan: false, mesh: false }
  /** 运行时探测结果（服务名 / 虚拟 IP），会随服务启停变化，所以带缓存。 */
  const detected = { serviceName: '', meshIp: '', meshAdapter: null, at: 0 }
  /** 实际使用的端口（自动避让后可能不是配置里的首选值）。 */
  const activePorts = { lan: Number(cfg.lanPort), mesh: Number(cfg.meshPort) }
  /** DSH 自己的回环端口，作为网关的转发目标（避免网关再去猜进程名）。 */
  let dshOrigin = ''

  /** 网关脚本：默认用随包分发的那个，配置了就用配置的。 */
  const gateScript = () => {
    if (typeof cfg.gateScript === 'string' && cfg.gateScript) return cfg.gateScript
    return BUNDLED_GATE
  }

  const gateAlive = (kind) => {
    const entry = gates.get(kind)
    return Boolean(entry && entry.child.exitCode === null && !entry.child.killed)
  }

  const gateHostPort = (kind) => (kind === 'lan'
    ? { host: cfg.lanHost, port: activePorts.lan }
    : { host: detected.meshIp || cfg.meshHost || '', port: activePorts.mesh })

  const waitFor = async (predicate, timeoutMs = 15000, stepMs = 500) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, stepMs))
    }
    return false
  }

  /**
   * 探测 EasyTier 的服务名与虚拟 IP。
   * 服务名优先用配置值，其次探常见名字，最后全量扫服务列表；虚拟 IP 从 `et_*` 网卡上读。
   */
  const detect = async (force = false) => {
    if (!force && Date.now() - detected.at < 5000) return detected
    detected.at = Date.now()
    if (!isWindows) {
      detected.serviceName = ''
      detected.meshIp = ''
      detected.meshAdapter = null
      return detected
    }

    let serviceName = typeof cfg.serviceName === 'string' ? cfg.serviceName : ''
    if (!serviceName) {
      for (const name of KNOWN_SERVICES) {
        const probe = await runCommand('sc.exe', ['query', name], 6000)
        if (probe.ok && /SERVICE_NAME/i.test(probe.stdout)) {
          serviceName = name
          break
        }
      }
    }
    if (!serviceName) {
      const all = await runCommand('sc.exe', ['query', 'type=', 'service', 'state=', 'all', 'bufsize=', '65535'], 12000)
      if (all.ok) {
        const names = Array.from(all.stdout.matchAll(/SERVICE_NAME:\s*(\S+)/gi)).map((match) => match[1])
        const hit = names.find((name) => /easytier/i.test(name))
        if (hit) serviceName = hit
      }
    }

    let meshIp = typeof cfg.meshIp === 'string' ? cfg.meshIp : ''
    let meshAdapter = null
    const virtuals = ipv4Interfaces().filter((item) => !item.internal && isEasyTierAdapterName(item.name))
    if (virtuals.length > 0) {
      // 有网卡就以网卡上的地址为准（EasyTier 允许用户改网段）
      meshIp = virtuals[0].address
      meshAdapter = virtuals[0]
    }

    detected.serviceName = serviceName
    detected.meshIp = meshIp
    if (meshAdapter) detected.meshAdapter = meshAdapter
    else if (!meshIp) detected.meshAdapter = null
    return detected
  }

  const meshAdapter = () => {
    const virtuals = ipv4Interfaces().filter((item) => !item.internal && isEasyTierAdapterName(item.name))
    if (virtuals.length > 0) return { name: virtuals[0].name, address: virtuals[0].address }
    return null
  }

  const serviceState = async () => {
    await detect()
    if (!detected.serviceName) return 'ABSENT'
    const result = await runCommand('sc.exe', ['query', detected.serviceName])
    const matched = result.stdout.match(/STATE\s*:\s*\d+\s+([A-Z_]+)/)
    if (!matched) return 'UNKNOWN'
    return matched[1]
  }

  /**
   * 读服务的「失败自愈策略」。有动作 = 停掉后会被 SCM 拉起（easytier-core 停止时非 0 退出）。
   * 注意 sc qfailure 的键名是 ASCII，但动作文本会被本地化（中文系统显示「重新启动 -- 延迟 = 5000 毫秒。」），
   * 所以只按「键行 vs 续行」的结构解析，不依赖 RESTART 这类关键字。
   */
  const serviceProtection = async () => {
    await detect()
    if (!detected.serviceName) return { known: false, protected: false, actions: [] }
    const r = await runCommand('sc.exe', ['qfailure', detected.serviceName], 10000)
    if (!r.ok) return { known: false, protected: false, actions: [] }
    const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/)
    const at = lines.findIndex((line) => /FAILURE_ACTIONS/i.test(line))
    if (at < 0) return { known: true, protected: false, actions: [] }
    const actions = []
    const firstValue = lines[at].split(':').slice(1).join(':').trim()
    if (firstValue) actions.push(firstValue)
    for (let i = at + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line.trim()) continue
      if (/^\s*[A-Z_]{3,}\s*:/.test(line)) break
      actions.push(line.trim())
    }
    return { known: true, protected: actions.length > 0, actions }
  }

  /** 本次要尝试的端口序列：首选端口 + 顺延若干个（配置 portRetry=0 时只试首选）。 */
  const portCandidates = (kind) => {
    const preferred = kind === 'lan' ? Number(cfg.lanPort) : Number(cfg.meshPort)
    const retry = Math.max(0, Number(cfg.portRetry) || 0)
    const list = []
    for (let i = 0; i <= retry; i += 1) list.push(preferred + i)
    return list
  }

  /**
   * 把端口从「别人拉起的旧网关」手里收回来：只认 node.exe，端口 + 监听地址都要对上。
   * 端口本来空着时返回 ok 且 message 为 null（表示无需动手）。
   */
  const reclaimPort = async (kind, port) => {
    const host = kind === 'lan' ? cfg.lanHost : (detected.meshIp || cfg.meshHost || '')
    if (!host) return { ok: false, message: '组网虚拟网卡还没有 IP' }
    const pid = await pidOnPort(runCommand, host, port)
    if (!pid) return { ok: true, message: null }
    if (pid === process.pid) return { ok: false, message: `端口 ${port} 正被 DSH 自己用着，不能接管` }
    const listed = await runCommand('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    if (!/"node\.exe"/i.test(listed.stdout)) {
      return { ok: false, message: `${host}:${port} 被非 node 进程占用（pid ${pid}），不敢动它`, occupied: true }
    }
    await runCommand('taskkill.exe', ['/PID', String(pid), '/F'])
    const freed = await waitFor(async () => (await pidOnPort(runCommand, host, port)) === null, 6000)
    return freed
      ? { ok: true, message: `已收掉旧网关 pid ${pid}` }
      : { ok: false, message: `${host}:${port} 上的旧网关 pid ${pid} 没能收掉` }
  }

  /** 在指定端口上拉起网关，并确认它真的在监听。 */
  const spawnGate = async (kind, host, port) => {
    const script = gateScript()
    if (!fs.existsSync(script)) {
      return { ok: false, fatal: true, message: `网关脚本不存在：${script}` }
    }
    const candidates = nodeCandidates(cfg)
    const useElectron = candidates.length === 0 || candidates[0] === process.execPath
    const nodeExe = candidates.length > 0 ? candidates[0] : process.execPath
    const env = { ...process.env }
    if (useElectron) env.ELECTRON_RUN_AS_NODE = '1'
    const gateLog = path.join(os.tmpdir(), `device-link-gate-${kind}.log`)
    const args = [script, '--host', host, '--port', String(port)]
    if (dshOrigin) args.push('--target', dshOrigin)
    args.push('--log', gateLog)
    const child = spawn(nodeExe, args, {
      cwd: path.dirname(script),
      env,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('exit', (code, signal) => {
      const entry = gates.get(kind)
      if (entry && entry.child === child) gates.delete(kind)
      log('info', `网关退出 ${host}:${port} code=${code} signal=${signal ?? ''}`)
    })
    child.on('error', (error) => {
      const entry = gates.get(kind)
      if (entry && entry.child === child) gates.delete(kind)
      log('warn', `网关启动失败 ${host}:${port}: ${error?.message ?? error}`)
    })
    // 起来以后用「netstat 里这个地址+端口的监听进程号 == 子进程 pid」来确认，而不是干等固定时间再猜。
    const serving = await waitFor(
      async () => child.exitCode !== null || (await pidOnPort(runCommand, host, port)) === child.pid,
      8000,
      250,
    )
    if (child.exitCode !== null || !serving) {
      gates.delete(kind)
      try { child.kill() } catch { /* ignore */ }
      return { ok: false, message: child.exitCode !== null
        ? `网关启动即退出（${host}:${port}，exit=${child.exitCode}）`
        : `网关进程起来了但 ${host}:${port} 没进入监听` }
    }
    gates.set(kind, { child, host, port })
    return { ok: true, message: `网关已启动（${host}:${port}）` }
  }

  const startGate = async (kind) => {
    if (gateAlive(kind)) return { ok: true, message: '网关已在运行' }
    if (kind === 'mesh') {
      await detect(true)
      if (!detected.meshIp && !cfg.meshHost) return { ok: false, message: '组网虚拟网卡还没有 IP，先启动 EasyTier 服务' }
    }
    const host = kind === 'lan' ? cfg.lanHost : (detected.meshIp || cfg.meshHost)
    const notes = []
    for (const port of portCandidates(kind)) {
      const reclaimed = await reclaimPort(kind, port)
      if (!reclaimed.ok) {
        if (reclaimed.occupied) { notes.push(reclaimed.message); continue }
        return reclaimed
      }
      if (reclaimed.message) notes.push(reclaimed.message)
      const started = await spawnGate(kind, host, port)
      if (started.ok) {
        activePorts[kind] = port
        if (notes.length > 0) log('info', notes.join('；'))
        return { ok: true, message: started.message, port }
      }
      notes.push(started.message)
      if (started.fatal) return started
    }
    return { ok: false, message: notes.filter(Boolean).join('；') || '网关没能起来' }
  }

  /** 停网关：优先收自己拉起的子进程；端口被外部 node 网关占着就顺手收掉那个。 */
  const stopGate = async (kind) => {
    const entry = gates.get(kind)
    if (entry) {
      gates.delete(kind)
      try { entry.child.kill() } catch { /* ignore */ }
      await new Promise((resolve) => setTimeout(resolve, 300))
      if ((await pidOnPort(runCommand, entry.host, entry.port)) !== null) {
        return { ok: false, message: `网关子进程已发停止信号，但 ${entry.host}:${entry.port} 还在监听` }
      }
      return { ok: true, message: '网关已停止' }
    }
    const reclaimed = await reclaimPort(kind, activePorts[kind])
    if (!reclaimed.ok && !reclaimed.occupied) return reclaimed
    return { ok: true, message: reclaimed.message ?? '网关本来就没在跑' }
  }

  const collectStatus = async () => {
    const [lanPid, meshHostPort, lanIp, service, protection] = await Promise.all([
      pidOnPort(runCommand, cfg.lanHost, activePorts.lan),
      (async () => {
        const host = detected.meshIp || cfg.meshHost || ''
        if (!host) return { host: '', pid: null }
        return { host, pid: await pidOnPort(runCommand, host, activePorts.mesh) }
      })(),
      primaryLanIp(),
      serviceState(),
      serviceProtection(),
    ])
    const adapter = meshAdapter()
    const peers = service === 'RUNNING' ? await peerCount(runCommand, Number(cfg.tunnelPort) || 11010) : 0
    const meshIp = (adapter && adapter.address) || detected.meshIp || cfg.meshIp || ''

    const lan = {
      on: lanPid !== null,
      port: activePorts.lan,
      url: `http://${lanIp ?? '<本机局域网IP>'}:${activePorts.lan}/`,
      owner: gateAlive('lan') ? 'plugin' : lanPid !== null ? 'external' : null,
    }
    const mesh = {
      on: meshHostPort.pid !== null,
      // 只要检测到 EasyTier 服务就算可用；服务停着也是一种正常状态（打开开关会去启动它），
      // 没有虚拟 IP 时要不要绑定端口，交给 startGate 去判断。
      available: isWindows ? Boolean(detected.serviceName) : false,
      reason: isWindows
        ? (detected.serviceName ? null : '未检测到 EasyTier（可选功能，不影响局域网互联；下面可以一键安装）')
        : MESH_UNSUPPORTED,
      serviceName: detected.serviceName || null,
      port: activePorts.mesh,
      ip: meshIp,
      url: meshIp ? `http://${meshIp}:${activePorts.mesh}/` : null,
      owner: gateAlive('mesh') ? 'plugin' : meshHostPort.pid !== null ? 'external' : null,
      service,
      adapter: adapter?.name ?? null,
      peers,
      stopProtected: protection.protected,
      stopProtectionKnown: protection.known,
    }
    return {
      ok: true,
      master: { on: lan.on || mesh.on },
      lan,
      mesh,
      setup: await setupSnapshot(),
      at: Date.now(),
    }
  }

  /** 关不掉时给用户的提示：不用绝对路径，照着复制命令即可。 */
  const stopProtectedHint = () => {
    const scripts = path.join(PKG_ROOT, 'scripts')
    const name = detected.serviceName || 'EasyTierService'
    return `要真停住：以管理员身份运行 \`sc failure ${name} reset= 0 actions= ""\``
      + `（一次性；还原自愈就用同目录的恢复脚本）。随包脚本在 ${scripts}`
  }

  const setMeshService = async (on) => {
    if (!isWindows) return { ok: false, message: MESH_UNSUPPORTED }
    await detect(true)
    if (!detected.serviceName) {
      return { ok: false, message: '未检测到 EasyTier 服务，组网互联不可用（局域网互联不受影响）' }
    }
    const state = await serviceState()
    if (on) {
      if (state === 'RUNNING' && meshAdapter()) return { ok: true, message: 'EasyTier 服务已在运行' }
      let restarted = false
      if (state === 'RUNNING') {
        // 服务在跑但虚拟网卡没有 IP（被连续重启后见过这种半死状态）：停一次再显式启动，
        // 等于 EasyTier 面板上的「重启组网」。
        log('warn', 'EasyTier 服务在跑但虚拟网卡没有介质，重启一次服务')
        await runCommand('sc.exe', ['stop', detected.serviceName], 20000)
        await waitFor(async () => (await serviceState()) !== 'RUNNING', 20000, 500)
        restarted = true
      }
      const started = await runCommand('sc.exe', ['start', detected.serviceName], 20000)
      // 若自愈策略已经把它拉起来了，sc start 会报 1056「服务的一个实例已在运行」，同样算成功。
      const alreadyRunning = /1056|already|已经在运行|已在运行/i.test(`${started.stdout}\n${started.stderr}`)
      if (!started.ok && !alreadyRunning) {
        return { ok: false, message: `启动 ${detected.serviceName} 失败：${started.stderr.trim() || started.stdout.trim()}` }
      }
      const up = await waitFor(() => meshAdapter() !== null, 30000)
      if (!up) return { ok: false, message: 'EasyTier 服务已启动，但虚拟网卡还没拿到 IP（稍等一下再看状态）' }
      await detect(true)
      return { ok: true, message: restarted ? 'EasyTier 服务已重启，虚拟网卡在线' : 'EasyTier 已启动，虚拟网卡在线' }
    }
    // ⚠ 这个服务常被装上「失败即重启」恢复策略（sc qfailure：RESTART ×3，间隔 5000ms；
    //    动作数少于失败次数时 Windows 会一直重复最后一个动作，等于次数无限）。而
    //    easytier-core 被 SCM 停掉时以非 0 退出码结束 → sc stop 之后 5 秒必被拉回。
    //    改恢复策略需要管理员，所以这里只停一次、如实报告「停不住」，不再空转重试。
    const stopped = await runCommand('sc.exe', ['stop', detected.serviceName], 20000)
    if (!stopped.ok) {
      return { ok: false, message: `停止 ${detected.serviceName} 失败：${stopped.stderr.trim() || stopped.stdout.trim()}` }
    }
    const isDown = await waitFor(async () => (await serviceState()) !== 'RUNNING', 20000)
    if (!isDown) return { ok: false, message: 'EasyTier 服务没有响应停止指令' }
    const cameBack = await waitFor(async () => (await serviceState()) === 'RUNNING', 8000, 400)
    if (!cameBack) {
      const protection = await serviceProtection()
      return {
        ok: true,
        message: protection.known && !protection.protected
          ? 'EasyTier 服务已停止（自愈策略已解除，不会再被拉起）'
          : 'EasyTier 服务已停止',
      }
    }
    return {
      ok: false,
      restartProtected: true,
      message: 'EasyTier 服务 5 秒后被系统自动拉起（服务自愈策略），普通权限停不住；对外网关已断开，手机已连不进来',
      detail: stopProtectedHint(),
    }
  }

  /** 状态落盘：只记三个开关的意图，不记运行时端口。 */
  const stateFile = () => (typeof cfg.statePath === 'string' && cfg.statePath) || DEFAULT_STATE_PATH

  const readStateRaw = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* 没存过或文件坏了都不算错 */ }
    return null
  }

  const readState = () => {
    const parsed = readStateRaw()
    if (parsed) {
      return { lan: Boolean(parsed.lan), mesh: Boolean(parsed.mesh), master: Boolean(parsed.master) }
    }
    return { lan: false, mesh: false, master: false }
  }

  /** 组网配置（网络名 / 密码 / 配置文件路径）跟三个开关共用一个状态文件。 */
  const readSetupState = () => {
    const parsed = readStateRaw()
    if (parsed && parsed.setup && typeof parsed.setup === 'object') return parsed.setup
    return null
  }

  let setupState = readSetupState()

  const writeState = () => {
    const payload = {
      lan: Boolean(desired.lan),
      mesh: Boolean(desired.mesh),
      master: Boolean(desired.lan || desired.mesh),
      at: new Date().toISOString(),
    }
    if (setupState) payload.setup = setupState
    try {
      const file = stateFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch (error) {
      log('warn', `开关状态落盘失败：${error?.message ?? error}`)
    }
    return payload
  }

  const saveSetupState = (next) => {
    setupState = next
    writeState()
    return next
  }

  // ——— EasyTier 安装 / 组网配置向导 ———
  // 目标：别人装上这个插件后，就算一台机器上什么都没有，也能被引导到「能组网」的状态：
  //   1. 自动检测有没有 EasyTier（core / 服务 / winget 三种线索都看）
  //   2. 没有就问用户要不要装（winget 一键；没有 winget 给下载页）
  //   3. 帮用户生成一份**属于他自己**的 easytier.toml（随机网络名/密码 + 公共汇合点）
  //   4. 帮他把 EasyTier 注册成 Windows 服务（管理员脚本，会弹 UAC）

  /** 用户数据目录：生成的配置、脚本日志都放这儿。 */
  const dataDir = () => path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'dsh-device-link',
  )

  /** 生成 / 读取的 easytier.toml 路径。 */
  const configPath = () => (typeof cfg.configPath === 'string' && cfg.configPath)
    || path.join(dataDir(), 'easytier.toml')

  /** 找 easytier-core.exe：显式配置 → PATH 常见的几个安装目录 → winget 包目录。 */
  const coreCandidates = () => {
    const list = []
    if (typeof cfg.corePath === 'string' && cfg.corePath) list.push(cfg.corePath)
    const dirs = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'EasyTier'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'EasyTier'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'EasyTier'),
      path.join(process.env.LOCALAPPDATA || '', 'easytier-gui'),
    ]
    for (const dir of dirs) {
      list.push(path.join(dir, 'easytier-core.exe'))
      list.push(path.join(dir, 'bin', 'easytier-core.exe'))
    }
    try {
      const winget = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages')
      for (const entry of fs.readdirSync(winget)) {
        if (!/easytier/i.test(entry)) continue
        const base = path.join(winget, entry)
        list.push(path.join(base, 'easytier-core.exe'))
        for (const inner of fs.readdirSync(base)) list.push(path.join(base, inner, 'easytier-core.exe'))
      }
    } catch { /* 没装 winget 或没有包目录，忽略 */ }
    return Array.from(new Set(list))
  }

  const exists = (file) => {
    try { return Boolean(file) && fs.existsSync(file) } catch { return false }
  }

  const findCore = () => coreCandidates().find((file) => exists(file)) || ''

  let wingetCache = null
  const wingetInfo = async () => {
    if (wingetCache) return wingetCache
    const result = await runCommand('winget.exe', ['--version'], 10000)
    const text = `${result.stdout}\n${result.stderr}`.trim()
    wingetCache = {
      available: result.ok && /\d+\.\d+/.test(text),
      version: (text.split(/\r?\n/).find((line) => /\d+\.\d+/.test(line)) || '').trim(),
    }
    return wingetCache
  }

  /** 卡片要的「环境体检」结果：装没装、能不能一键装、配置生成到哪了。 */
  const setupSnapshot = async () => {
    await detect()
    const core = findCore()
    const winget = await wingetInfo()
    const file = configPath()
    const saved = setupState || {}
    const peers = Array.isArray(cfg.meetPeers) ? cfg.meetPeers.filter((uri) => typeof uri === 'string' && uri.trim()) : []
    return {
      // 有 core、有服务，都算装了（有人只装了 GUI）
      installed: Boolean(core) || Boolean(detected.serviceName),
      corePath: core || null,
      serviceName: detected.serviceName || null,
      winget: winget.available ? winget.version : null,
      installUrl: String(cfg.installUrl || INSTALL_URL),
      configPath: file,
      configExists: exists(file),
      configured: Boolean(saved.networkName),
      networkName: saved.networkName || null,
      secretMasked: saved.secret ? `${String(saved.secret).slice(0, 3)}••••${String(saved.secret).slice(-2)}` : null,
      ipv4: saved.ipv4 || null,
      peers,
      peerSample: peers[0] || null,
      scriptPath: path.join(PKG_ROOT, 'scripts', 'easytier-setup-service.ps1'),
    }
  }

  /** 由网络名派生子网前缀，保证同一网络的人落在同一个 /24，但外人看不出规律。 */
  const subnetSeed = (text) => {
    let sum = 7
    for (const ch of String(text)) sum = (sum * 31 + ch.codePointAt(0)) % 65521
    return sum
  }

  const buildToml = (info) => {
    const peers = Array.isArray(cfg.meetPeers) ? cfg.meetPeers.filter((uri) => typeof uri === 'string' && uri.trim()) : []
    const lines = [
      '# ============================================================',
      '# 由 dsh-device-link 生成的 EasyTier 配置',
      '# ------------------------------------------------------------',
      '# 想让另一台设备（手机 / 朋友的电脑）连进来：',
      '#   在对方那里填「网络名称 + 网络密码」，汇合点任选下面一个。',
      '# 改完这个文件要重启 EasyTier 服务才生效。',
      '# ============================================================',
      '',
      '# 本机在虚拟网里的地址（想固定就留着；两台设备撞了 IP 就改最后的数字）',
      `ipv4 = "${info.ipv4}"`,
      '',
      'listeners = [',
      '    "tcp://0.0.0.0:11010",',
      '    "udp://0.0.0.0:11010",',
      '    "wg://0.0.0.0:11011",',
      ']',
      'tcp_whitelist = []',
      'udp_whitelist = []',
      '',
      '[network_identity]',
      '# 网络名称 / 密码是本机随机生成的，发给谁就等于邀请谁进这个虚拟网',
      `network_name = "${info.networkName}"`,
      `network_secret = "${info.secret}"`,
      '',
      '# ---------- 汇合点（公共共享节点，只负责让双方互相发现）----------',
      '# 这些是社区公开节点，随时可能失效；失效了换成别的公共节点即可，',
      '# 只要两台设备连的是同一个节点就能找到彼此。',
      '',
    ]
    for (const uri of peers) {
      lines.push('[[peer]]', `uri = "${uri}"`, '')
    }
    lines.push(
      '# ---------- 可选：进阶开关（需要时删掉行首的 # 即可）----------',
      '# [flags]',
      '# default_protocol = "tcp"',
      '# enable_encryption = true',
      '# latency_first = true',
      '',
    )
    return lines.join('\n')
  }

  const generateSetup = async () => {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
    const random = (count) => Array.from({ length: count }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
    const networkName = `dsh-${random(6)}`
    const seed = subnetSeed(networkName)
    const info = {
      networkName,
      secret: random(16),
      // 10.x.y.z/24：x/y 由网络名派生（同网同段），z 随机（避免两台设备撞同一地址）
      ipv4: `10.${144 + (seed % 40)}.${Math.floor(seed / 40) % 256}.${2 + Math.floor(Math.random() * 250)}/24`,
      at: new Date().toISOString(),
    }
    const file = configPath()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, buildToml(info), 'utf8')
    } catch (error) {
      return { ok: false, message: `写配置文件失败：${error?.message ?? error}` }
    }
    saveSetupState(info)
    log('info', `生成组网配置：${file}（网络名 ${networkName}）`)
    return {
      ok: true,
      message: `已生成组网配置：${file}`,
      secret: info.secret,
      setup: await setupSnapshot(),
    }
  }

  const revealSetup = () => {
    if (!setupState?.secret) return { ok: false, message: '还没有生成过组网配置' }
    return {
      ok: true,
      networkName: setupState.networkName,
      secret: setupState.secret,
      message: '已显示',
    }
  }

  const installEasyTier = async () => {
    const winget = await wingetInfo()
    if (!winget.available) {
      return {
        ok: false,
        needsManual: true,
        message: `这台机器没有 winget，请到下载页手动安装：${cfg.installUrl}`,
        detail: String(cfg.installUrl || INSTALL_URL),
      }
    }
    log('info', `开始用 winget 安装 ${cfg.wingetId}（可能要几十秒，可能会弹 UAC）`)
    const result = await runCommand('winget.exe', [
      'install', '--id', String(cfg.wingetId), '-e',
      '--accept-package-agreements', '--accept-source-agreements',
      '--disable-interactivity', '--silent',
    ], 300000)
    const text = `${result.stdout}\n${result.stderr}`.trim()
    const tail = text.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ')
    wingetCache = null
    await detect(true)
    const core = findCore()
    if (core) {
      log('info', `EasyTier 安装完成：${core}`)
      return { ok: true, message: 'EasyTier 已安装', detail: core, setup: await setupSnapshot() }
    }
    log('warn', `winget 安装后仍没找到 easytier-core.exe：${tail}`)
    return {
      ok: false,
      message: 'winget 装完了，但没找到 easytier-core.exe（可能被 UAC 拦了，或需要重启一次终端）',
      detail: tail || String(cfg.installUrl || INSTALL_URL),
    }
  }

  /** 把生成的配置注册成 Windows 服务（管理员脚本，自己会弹 UAC）。 */
  const registerService = async () => {
    if (!isWindows) return { ok: false, message: MESH_UNSUPPORTED }
    const core = findCore()
    if (!core) return { ok: false, message: '没找到 easytier-core.exe，先安装 EasyTier' }
    if (!setupState?.networkName) return { ok: false, message: '先点「生成组网配置」，再注册服务' }
    const script = path.join(PKG_ROOT, 'scripts', 'easytier-setup-service.ps1')
    if (!exists(script)) return { ok: false, message: `缺少注册脚本：${script}` }
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-ConfigPath', configPath(), '-CorePath', core,
    ]
    if (detected.serviceName) args.push('-ServiceName', detected.serviceName)
    log('info', '注册 EasyTier 服务（会弹 UAC，请在弹窗里点“是”）')
    const result = await runCommand('powershell.exe', args, 180000)
    const text = `${result.stdout}\n${result.stderr}`.trim()
    const tail = text.split(/\r?\n/).filter(Boolean).slice(-8).join(' | ')
    await detect(true)
    const state = await serviceState()
    if (state === 'RUNNING' || state === 'STOPPED') {
      log('info', `EasyTier 服务就绪：${detected.serviceName} ${state}`)
      return { ok: true, message: `EasyTier 服务已就绪（${detected.serviceName} · ${state}）`, detail: tail, setup: await setupSnapshot() }
    }
    return {
      ok: false,
      message: '注册服务没成功（多半是 UAC 弹窗被取消了）',
      detail: tail || text || '没有输出',
    }
  }

  const toggle = async (kind, on) => {
    if (busy.has(kind)) return { ok: false, message: '上一个操作还没结束' }
    busy.add(kind)
    const notes = []
    try {
      if (kind === 'lan') {
        if (on) {
          const started = await startGate('lan')
          notes.push(started.message)
          if (!started.ok) return { ok: false, message: started.message, status: await collectStatus() }
        } else {
          const stopped = await stopGate('lan')
          notes.push(stopped.message)
          if (!stopped.ok) return { ok: false, message: stopped.message, status: await collectStatus() }
        }
      } else if (kind === 'mesh') {
        if (on) {
          const service = await setMeshService(true)
          notes.push(service.message)
          if (!service.ok) return { ok: false, message: service.message, status: await collectStatus() }
          const started = await startGate('mesh')
          notes.push(started.message)
          if (!started.ok) return { ok: false, message: started.message, status: await collectStatus() }
        } else {
          const stoppedGate = await stopGate('mesh')
          notes.push(stoppedGate.message)
          const service = await setMeshService(false)
          notes.push(service.message)
          if (!service.ok) {
            return {
              ok: false,
              message: notes.filter(Boolean).join('；'),
              detail: service.detail ?? null,
              restartProtected: Boolean(service.restartProtected),
              status: await collectStatus(),
            }
          }
        }
      } else if (kind === 'master') {
        // 总开关 = 局域网互联 + 组网互联 一起管（组网侧连带 EasyTier 服务）
        if (on) {
          const lan = await startGate('lan')
          notes.push(lan.message)
          const service = await setMeshService(true)
          notes.push(service.message)
          if (service.ok) {
            const mesh = await startGate('mesh')
            notes.push(mesh.message)
          }
          if (!lan.ok || !service.ok) {
            return {
              ok: false,
              message: notes.filter(Boolean).join('；'),
              detail: service.detail ?? null,
              status: await collectStatus(),
            }
          }
        } else {
          notes.push((await stopGate('lan')).message)
          notes.push((await stopGate('mesh')).message)
          const service = await setMeshService(false)
          notes.push(service.message)
          if (!service.ok) {
            return {
              ok: false,
              message: notes.filter(Boolean).join('；'),
              detail: service.detail ?? null,
              restartProtected: Boolean(service.restartProtected),
              status: await collectStatus(),
            }
          }
        }
      } else {
        return { ok: false, message: `未知开关：${kind}` }
      }
      // 操作成功了，把「意图」对齐到当前真实状态再落盘。
      desired.lan = gateAlive('lan')
      desired.mesh = gateAlive('mesh')
      writeState()
      return { ok: true, message: notes.filter(Boolean).join('；'), status: await collectStatus() }
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error), status: await collectStatus() }
    } finally {
      busy.delete(kind)
    }
  }

  const readBody = (req, limit = 8192) =>
    new Promise((resolve, reject) => {
      let total = 0
      const chunks = []
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > limit) {
          reject(new Error('请求体太大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const handler = async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    const send = (code, payload) => {
      try {
        res.statusCode = code
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(payload))
      } catch { /* 连接已断 */ }
    }
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch { /* ignore */ }

    try {
      if (pathname.endsWith('/setup.json')) {
        if (req.method !== 'POST') return send(405, { ok: false, message: '只支持 POST' })
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { return send(400, { ok: false, message: '请求体不是 JSON' }) }
        const action = String(body.action ?? '')
        if (action === 'install') {
          const result = await installEasyTier()
          log('info', `setup install : ${result.message ?? ''}`)
          return send(200, result)
        }
        if (action === 'generate') {
          const result = await generateSetup()
          log('info', `setup generate : ${result.message ?? ''}`)
          return send(200, result)
        }
        if (action === 'reveal') return send(200, revealSetup())
        if (action === 'register') {
          const result = await registerService()
          log('info', `setup register : ${result.message ?? ''}`)
          return send(200, result)
        }
        if (action === 'status') return send(200, { ok: true, setup: await setupSnapshot() })
        return send(400, { ok: false, message: `未知操作：${action}` })
      }
      if (pathname.endsWith('/toggle.json')) {
        if (req.method !== 'POST') return send(405, { ok: false, message: '只支持 POST' })
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { return send(400, { ok: false, message: '请求体不是 JSON' }) }
        const kind = String(body.switch ?? '')
        if (!['master', 'lan', 'mesh'].includes(kind)) return send(400, { ok: false, message: `未知开关：${kind}` })
        const result = await toggle(kind, Boolean(body.on))
        log('info', `toggle ${kind} -> ${body.on ? 'on' : 'off'} : ${result.message ?? ''}`)
        return send(200, result)
      }
      if (req.method !== 'GET') return send(405, { ok: false, message: '只支持 GET' })
      return send(200, await collectStatus())
    } catch (error) {
      return send(500, { ok: false, message: String(error?.message ?? error) })
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    // 网关的转发目标是「DSH 自己正在听的回环端口」，直接问宿主要，不再靠 tasklist 猜进程名。
    try {
      const origin = typeof webCtx.webServer.getOrigin === 'function' ? webCtx.webServer.getOrigin() : ''
      const match = String(origin || '').match(/^https?:\/\/[^:/]+:(\d+)/)
      if (match) dshOrigin = match[1]
      log('info', `DSH 回环端口：${dshOrigin || '未知（网关会自己发现）'}`)
    } catch { /* 拿不到就退回网关自身的发现逻辑 */ }

    const disposers = [
      '/api/device-link/status.json',
      '/device-link/status.json',
      '/api/device-link/toggle.json',
      '/device-link/toggle.json',
      '/api/device-link/setup.json',
      '/device-link/setup.json',
    ].map((routePath) => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }))
    log('info', '已注册 设备互联状态/开关/配置 端点（/api/device-link/*）')

    // DSH 重启后把上次开着的通道恢复回来（失败只记日志，不打扰用户）。
    if (cfg.restoreState !== false) {
      const saved = readState()
      if (saved.lan || saved.mesh) {
        desired.lan = Boolean(saved.lan)
        desired.mesh = Boolean(saved.mesh)
        setTimeout(() => {
          void (async () => {
            try {
              if (saved.lan) {
                const lan = await startGate('lan')
                log(lan.ok ? 'info' : 'warn', `恢复局域网互联：${lan.message}`)
              }
              if (saved.mesh) {
                const service = await setMeshService(true)
                log(service.ok ? 'info' : 'warn', `恢复组网服务：${service.message}`)
                if (service.ok) {
                  const mesh = await startGate('mesh')
                  log(mesh.ok ? 'info' : 'warn', `恢复组网互联：${mesh.message}`)
                }
              }
            } catch (error) {
              log('warn', `恢复开关状态失败：${error?.message ?? error}`)
            } finally {
              // 恢复完把落盘对齐到真实结果，避免下次开机反复重试一个起不来的通道。
              desired.lan = gateAlive('lan')
              desired.mesh = gateAlive('mesh')
              writeState()
            }
          })()
        }, 2000)
      }
    }

    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* ignore */ }
      }
      for (const entry of gates.values()) {
        try { entry.child.kill() } catch { /* ignore */ }
      }
      gates.clear()
      writeState()
    }
  }, 'device-link:routes')
}
