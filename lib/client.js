window.__ModuleLoader__.load({
  id: 'dsh-device-link',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATUS_PATHS = ['api/device-link/', 'device-link/']
    const STATUS_MS = 4000
    const STYLE_ID = 'dsh-device-link-style'

    const CSS = [
      // 与 @linxin666/dsh-remote-web-ui 同款：把 footArea 改成可换行的横排，
      // 让 footer.action 里的 entry 与 Settings 行同排（图标落在设置行右侧）。
      '.dwl-entryRow{flex:none;align-items:center;gap:6px;min-width:0;display:flex}',
      '.dwl-entryRow[data-rail=rail]{flex-direction:column-reverse;gap:4px}',
      '[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=footArea]{flex-flow:wrap;align-items:center}',
      '[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=footArea]>:not([class*=settingsArea]):not([class*=footerActions]){flex:100%;min-width:0}',
      '[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=footArea]>[class*=footerActions]{display:contents}',
      '[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=footerActions]>[data-slot="sidebar.footer.action"]>:not([data-dsh-part=entry]):not([class*=entryRow]){flex:100%;order:1;min-width:0}',
      '[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=footerActions]>[data-slot="sidebar.footer.action"]>[data-dsh-part=entry],[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=footerActions]>[data-slot="sidebar.footer.action"]>[class*=entryRow]{flex:none;order:4;min-width:0}',
      '[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=settingsArea]{flex:auto;order:3;width:auto;min-width:0}',
      '[data-dsh-frame][data-sidebar-collapsed] [class*=footerActions]:has([data-rail=rail]){flex-direction:column;align-items:center;gap:4px}',
      '.dwl-trigger{position:relative;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;border-radius:50%;cursor:pointer;color:var(--dsw-alias-label-secondary);padding:0;flex:none}',
      '.dwl-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dwl-trigger.is-on{color:var(--dsw-alias-brand-primary)}',
      '.dwl-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dwl-dot{position:absolute;right:7px;top:7px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary)}',
      '.dwl-panel{position:fixed;left:12px;bottom:78px;width:308px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3);font-size:12.5px;line-height:1.55}',
      '.dwl-head{display:flex;align-items:center;gap:8px}',
      '.dwl-title{font-size:13px;font-weight:600;flex:1}',
      '.dwl-close{width:22px;height:22px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:6px;cursor:pointer;font-size:14px;line-height:1;padding:0}',
      '.dwl-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dwl-row{display:flex;align-items:center;gap:10px;padding:8px 9px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.dwl-row-text{flex:1;min-width:0}',
      '.dwl-row-label{font-weight:600}',
      '.dwl-row-desc{color:var(--dsw-alias-label-tertiary);font-size:11.5px;word-break:break-all}',
      '.dwl-switch{position:relative;width:36px;height:20px;border-radius:999px;border:0;padding:0;flex:none;cursor:pointer;background:var(--dsw-alias-border-l2);transition:background .18s}',
      '.dwl-switch.is-on{background:var(--dsw-alias-brand-primary)}',
      '.dwl-switch:disabled{opacity:.55;cursor:default}',
      '.dwl-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dwl-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .18s;display:block}',
      '.dwl-switch.is-on .dwl-knob{left:18px}',
      '.dwl-msg{color:var(--dsw-alias-state-error-primary);font-size:11.5px;word-break:break-all}',
      '.dwl-note{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dwl-setup{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;background:transparent;border:1px solid var(--dsw-alias-border-l2)}',
      '.dwl-setup-title{font-weight:600;font-size:12.5px;line-height:1.45}',
      '.dwl-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px}',
      '.dwl-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap;transition:background .15s ease,color .15s ease}',
      '.dwl-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dwl-btn:focus-visible{outline:2px solid var(--dsw-alias-border-l2);outline-offset:1px}',
      '.dwl-btn:disabled{opacity:.45;cursor:default;background:transparent;color:var(--dsw-alias-label-tertiary)}',
      '.dwl-btn.is-primary{background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dwl-btn.is-primary:hover{background:var(--dsw-alias-brand-primary);color:#fff;opacity:.88}',
      '.dwl-btn.is-primary:disabled{background:var(--dsw-alias-border-l2);color:#fff;opacity:1}',
      '.dwl-kv{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.5}',
      '.dwl-kv-k{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.dwl-kv-v{flex:1;min-width:0;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary);word-break:break-all}',
    ].join('')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function api(name, init) {
      let lastError = null
      for (const base of STATUS_PATHS) {
        try {
          const response = await fetch(base + name, { cache: 'no-store', ...(init || {}) })
          if (!response.ok) {
            lastError = new Error('HTTP ' + response.status)
            continue
          }
          return await response.json()
        } catch (error) {
          lastError = error
        }
      }
      throw lastError || new Error('接口不可用')
    }

    function WifiIcon(props) {
      return h('svg', {
        viewBox: '0 0 24 24', width: props.size || 17, height: props.size || 17,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
        strokeLinecap: 'round', 'aria-hidden': true, style: { display: 'block' },
      },
      h('path', { d: 'M2.9 8.7a13.2 13.2 0 0 1 18.2 0' }),
      h('path', { d: 'M6.2 12.1a8.4 8.4 0 0 1 11.6 0' }),
      h('path', { d: 'M9.5 15.5a3.6 3.6 0 0 1 5 0' }),
      h('circle', { cx: 12, cy: 19, r: 1.3, fill: 'currentColor', stroke: 'none' }))
    }

    function Row(props) {
      return h('div', { className: 'dwl-row' },
        h('div', { className: 'dwl-row-text' },
          h('div', { className: 'dwl-row-label' }, props.label),
          h('div', { className: 'dwl-row-desc' }, props.desc)),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': props.on ? 'true' : 'false',
          'aria-label': props.label,
          title: props.on ? '点击关闭' : '点击开启',
          className: 'dwl-switch' + (props.on ? ' is-on' : ''),
          disabled: Boolean(props.disabled),
          onClick: () => { if (!props.disabled) props.onChange(!props.on) },
        }, h('span', { className: 'dwl-knob' })))
    }

    function useRail() {
      const [rail, setRail] = React.useState(false)
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const read = () => setRail(Boolean(document.querySelector('[data-dsh-frame][data-sidebar-collapsed]')))
        read()
        if (typeof MutationObserver === 'undefined') return undefined
        const observer = new MutationObserver(read)
        observer.observe(document.documentElement, {
          attributes: true,
          subtree: true,
          attributeFilter: ['data-sidebar-collapsed'],
        })
        return () => observer.disconnect()
      }, [])
      return rail
    }

    function WifiEntry() {
      const rail = useRail()
      const [open, setOpen] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [loadError, setLoadError] = React.useState('')
      const [hint, setHint] = React.useState('')
      const [setupBusy, setSetupBusy] = React.useState('')
      const [setupMsg, setSetupMsg] = React.useState('')
      const [secret, setSecret] = React.useState('')
      const rootRef = React.useRef(null)

      const load = React.useCallback(async () => {
        try {
          const next = await api('status.json')
          setStatus(next)
          setLoadError('')
        } catch (err) {
          setLoadError('读不到状态：' + String((err && err.message) || err))
        }
      }, [])

      React.useEffect(() => {
        ensureStyle()
        load()
        const timer = setInterval(load, STATUS_MS)
        return () => clearInterval(timer)
      }, [load])

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const toggle = async (kind, on) => {
        setBusy(kind)
        try {
          const result = await api('toggle.json', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ switch: kind, on }),
          })
          if (result && result.status) setStatus(result.status)
          setError(result && result.ok ? '' : String((result && result.message) || '操作失败'))
          setHint(result && result.restartProtected ? String(result.detail || '') : '')
          if (!result || !result.status) await load()
        } catch (err) {
          setError('操作失败：' + String((err && err.message) || err))
        } finally {
          setBusy('')
        }
      }

      const lan = (status && status.lan) || {}
      const mesh = (status && status.mesh) || {}
      const master = (status && status.master) || {}
      const setup = (status && status.setup) || {}
      const anyOn = Boolean(master.on)
      const meshAvailable = Boolean(mesh.available)
      const meshRunning = mesh.service === 'RUNNING'

      const setupAction = async (action) => {
        // 注册/重装会把这台机器上同名的 EasyTier 服务换成新配置，先让用户确认一次
        if (action === 'register') {
          const tip = setup.serviceName
            ? '会把本机现有的「' + setup.serviceName + '」服务换成这份新配置：原来的组网会先停掉，之后用新网络名和密码重新组网。继续？'
            : '会新建一个 EasyTier 服务并写入防火墙规则（需要一次管理员确认）。继续？'
          if (!window.confirm(tip)) return
        }
        setSetupBusy(action)
        setSetupMsg('')
        try {
          const result = await api('setup.json', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          })
          const ok = Boolean(result && result.ok)
          const text = String((result && (result.message || result.detail)) || '')
          setSetupMsg(ok ? text : '✕ ' + text)
          if (result && result.secret) setSecret(String(result.secret))
          if (result && result.setup) setStatus((prev) => Object.assign({}, prev || {}, { setup: result.setup }))
          if (action !== 'reveal') await load()
        } catch (err) {
          setSetupMsg('✕ ' + String((err && err.message) || err))
        } finally {
          setSetupBusy('')
        }
      }

      const openDownload = () => {
        const url = String(setup.installUrl || 'https://github.com/EasyTier/EasyTier/releases/latest')
        try { window.open(url, '_blank', 'noopener') } catch { setSetupMsg('打开失败，请手动访问：' + url) }
      }

      const copyInvite = async () => {
        try {
          let value = secret
          if (!value) {
            const result = await api('setup.json', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'reveal' }),
            })
            value = String((result && result.secret) || '')
            if (value) setSecret(value)
          }
          if (!value) { setSetupMsg('✕ 还没有网络密码，先生成配置'); return }
          const lines = [
            '设备互联组网邀请',
            '网络名称：' + String(setup.networkName || ''),
            '网络密码：' + value,
            '汇合点（任一即可）：' + String(setup.peerSample || ''),
          ]
          await navigator.clipboard.writeText(lines.join('\n'))
          setSetupMsg('已复制邀请信息，发给对方即可')
        } catch (err) {
          setSetupMsg('✕ 复制失败：' + String((err && err.message) || err))
        }
      }

      // 一行「键 : 值」，键用浅色，值用等宽字体（网络名 / 密码 / 虚拟 IP）
      const kv = (label, value) =>
        h('div', { className: 'dwl-kv' },
          h('span', { className: 'dwl-kv-k' }, label),
          h('span', { className: 'dwl-kv-v' }, value))


      const icpDesc = !meshAvailable
        ? String(mesh.reason || '未检测到 EasyTier（可选功能，不影响局域网互联）')
        : !mesh.on
          ? (meshRunning
              ? (mesh.stopProtected
                  ? '入口已断；EasyTier 服务受自愈策略保护仍在跑（管理员执行 sc failure ' + String(mesh.serviceName || 'EasyTierService') + ' reset= 0 actions= "" 才能真关）'
                  : '入口已断；EasyTier 服务已停止')
              : 'EasyTier 未运行（打开会自动启动服务）')
          : (mesh.adapter
              ? 'EasyTier 运行中' + (mesh.peers ? ' · 节点 ' + mesh.peers : '') + ' · ' + String(mesh.ip || '')
              : '入口已开，EasyTier 还在启动…')
      const lanDesc = lan.on
        ? String(lan.url || '') + ' 可访问'
        : '同一 WiFi 下用 ' + String(lan.url || '本机局域网地址') + ' 访问'

      const setupBlock = !setup.installed
        ? h('div', { className: 'dwl-setup' },
            h('div', { className: 'dwl-setup-title' }, '没装 EasyTier？'),
            h('div', { className: 'dwl-note' }, '组网互联需要它（局域网互联不需要）。装好后插件可以帮你生成组网配置。'),
            h('div', { className: 'dwl-actions' },
              setup.winget
                ? h('button', {
                    type: 'button', className: 'dwl-btn is-primary', disabled: Boolean(setupBusy),
                    onClick: () => setupAction('install'),
                  }, setupBusy === 'install' ? '安装中…' : '用 winget 安装')
                : null,
              h('button', { type: 'button', className: 'dwl-btn', onClick: openDownload }, '打开下载页'),
              h('button', { type: 'button', className: 'dwl-btn', disabled: Boolean(setupBusy), onClick: () => load() }, '重新检测')),
            setupMsg ? h('div', { className: 'dwl-note' }, setupMsg) : null)
        : !setup.configured
          ? h('div', { className: 'dwl-setup' },
              h('div', { className: 'dwl-setup-title' }, '组网配置'),
              h('div', { className: 'dwl-note' }, '生成你自己的随机网络名、密码和虚拟 IP，汇合点用公共节点，不含任何人的私有信息。'),
              h('div', { className: 'dwl-actions' },
                h('button', {
                  type: 'button', className: 'dwl-btn is-primary', disabled: Boolean(setupBusy),
                  onClick: () => setupAction('generate'),
                }, setupBusy === 'generate' ? '生成中…' : '生成配置'),
                h('button', { type: 'button', className: 'dwl-btn', onClick: openDownload }, '下载页')),
              setupMsg ? h('div', { className: 'dwl-note' }, setupMsg) : null)
          : h('div', { className: 'dwl-setup' },
              h('div', { className: 'dwl-setup-title' }, '组网配置'),
              kv('网络名称', String(setup.networkName || '')),
              kv('网络密码', String(secret || setup.secretMasked || '—')),
              kv('虚拟 IP', String(setup.ipv4 || '—')),
              h('div', { className: 'dwl-actions' },
                h('button', {
                  type: 'button', className: 'dwl-btn', disabled: Boolean(setupBusy),
                  onClick: () => (secret ? setSecret('') : setupAction('reveal')),
                }, secret ? '隐藏密码' : '显示密码'),
                h('button', { type: 'button', className: 'dwl-btn is-primary', onClick: copyInvite }, '复制邀请'),
                h('button', {
                  type: 'button', className: 'dwl-btn', disabled: Boolean(setupBusy),
                  onClick: () => setupAction('register'),
                }, setupBusy === 'register' ? '注册中…' : (setup.serviceName ? '重装服务' : '注册服务'))),
              setupMsg ? h('div', { className: 'dwl-note' }, setupMsg) : null)

      return h('div', {
        ref: rootRef,
        className: 'dwl-entryRow',
        'data-rail': rail ? 'rail' : 'wide',
        'data-wide': rail ? 'rail' : 'wide',
      },
        h('button', {
          type: 'button',
          className: 'dwl-trigger' + (anyOn ? ' is-on' : ''),
          title: anyOn ? '设备互联：已开启' : '设备互联：全部关闭',
          'aria-label': '设备互联',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
        h(WifiIcon, { size: rail ? 18 : 16 }),
        anyOn ? h('span', { className: 'dwl-dot' }) : null),
        open
          ? h('div', { className: 'dwl-panel', role: 'dialog', 'aria-label': '设备互联' },
              h('div', { className: 'dwl-head' },
                h(WifiIcon, { size: 16 }),
                h('span', { className: 'dwl-title' }, '设备互联'),
                h('button', {
                  type: 'button', className: 'dwl-close', title: '关闭', 'aria-label': '关闭',
                  onClick: () => setOpen(false),
                }, '×')),
              h(Row, {
                label: '互联',
                desc: anyOn ? '对外通道已放开，手机可以连进来' : '关闭时两个入口都停掉，手机连不进来',
                on: anyOn,
                disabled: busy === 'master',
                onChange: (value) => toggle('master', value),
              }),
              h(Row, {
                label: '局域网互联',
                desc: lanDesc,
                on: Boolean(lan.on),
                disabled: busy === 'lan',
                onChange: (value) => toggle('lan', value),
              }),
              h(Row, {
                label: '组网互联',
                desc: icpDesc,
                on: Boolean(mesh.on),
                disabled: busy === 'mesh' || !meshAvailable,
                onChange: (value) => toggle('mesh', value),
              }),
              setupBlock,
              loadError ? h('div', { className: 'dwl-msg' }, loadError) : null,
              error ? h('div', { className: 'dwl-msg' }, error) : null,
              hint ? h('div', { className: 'dwl-note' }, hint) : null,
              h('div', { className: 'dwl-note' }, '只做服务启停，不改 EasyTier 配置。开启后同网络的人可直连你的 DSH，请只在信任的网络下使用。'),
            )
          : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('sidebar.footer.action', () => {
            try {
              return ctx.slots.register({
                name: 'sidebar.footer.action',
                id: 'device-link',
                order: 5,
              }, WifiEntry)
            } catch {
              return () => {}
            }
          }, 'device-link:sidebar-foot')
        } catch (error) {
          console.warn('[device-link] 侧边栏挂载失败', error)
        }
      },
    }
  },
})
