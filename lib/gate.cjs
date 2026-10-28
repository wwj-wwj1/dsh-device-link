#!/usr/bin/env node
/**
 * DSH 带鉴权的访问网关（零依赖，Node 内置模块）
 *
 * 背景：DSH 桌面版只监听 127.0.0.1，浏览器访问必须持有宿主签发的 Cookie。
 * 宿主的签名密钥持久化在 `~/.dsh/.credentials.yaml` 的
 * `client-connection/browser-session` 记录里，Cookie 格式为
 *   `dsh-auth-<base64url(sha256(authority))>=v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>`
 * 其中 authority 就是请求的 Host 头（非 TLS 时）。
 *
 * 本脚本在对外地址上监听，把每个进来的请求**自动补上这个 Cookie**，
 * 再转发给 DSH 当前的回环端口，因此手机/平板上的浏览器无需任何登录操作。
 * WebSocket（GUI 的实时通道）同样转发。
 *
 * 用法：
 *   node dsh-gate.cjs                       # 监听 0.0.0.0:8899
 *   node dsh-gate.cjs --host 10.0.0.2       # 只绑定某个网卡地址（例如组网虚拟网卡）
 *   node dsh-gate.cjs --port 8899 --target 1766
 *   环境变量 DSH_CREDENTIALS 可指定凭据文件（默认 $env:USERPROFILE\.dsh\.credentials.yaml）
 */
'use strict';

const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { createHash, createHmac } = require('node:crypto');
const { execFile } = require('node:child_process');

const args = process.argv.slice(2);
function argOf(name, fallback) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const LISTEN_HOST = argOf('--host', process.env.GATE_HOST || '0.0.0.0');
const LISTEN_PORT = Number(argOf('--port', process.env.GATE_PORT || 8899));
const FIXED_TARGET = argOf('--target', process.env.GATE_TARGET || '');
const TARGET_HOST = '127.0.0.1';
const COOKIE_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;
const CREDENTIALS_FILE = process.env.DSH_CREDENTIALS || path.join(os.homedir(), '.dsh', '.credentials.yaml');
const LOG_FILE = argOf('--log', process.env.GATE_LOG || path.join(os.tmpdir(), 'device-link-gate.log'));

function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    process.stdout.write(line + '\n');
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch {
        /* 忽略日志失败 */
    }
}

/** 从 credentials.yaml 里取浏览器会话签名密钥（base64url，32 字节）。 */
function loadSecret() {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const match = /browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{40,})/.exec(text);
    if (!match) throw new Error(`在 ${CREDENTIALS_FILE} 里找不到 client-connection/browser-session 的 secret`);
    return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

const SECRET = loadSecret();

function b64url(buffer) {
    return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** 按宿主同款规则，为某个 authority（Host 头）签发 Cookie 名与值。 */
function authCookie(authority) {
    const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
    const issuedAt = Date.now() - 1000;
    const expiresAt = issuedAt + COOKIE_MAX_AGE_MS;
    const payload = { version: 1, authority, issuedAt, expiresAt };
    const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const sig = b64url(createHmac('sha256', SECRET).update(body).digest());
    return { name, value: `v1.${body}.${sig}` };
}

/**
 * 把客户端请求头改写成“宿主眼里的本机请求”：
 * - Host 改成 127.0.0.1:<port>（宿主只信任回环 Host）
 * - 去掉 Origin / Referer（宿主对 WebSocket 升级会校验 Origin，非回环来源直接 403）
 * - 补上按该 authority 自签的会话 Cookie
 * 原来的 Host 放进 X-Forwarded-Host 备查。
 */
function rewriteHeaders(headers, originalAuthority, targetAuthority) {
    const next = { ...headers };
    next.host = targetAuthority;
    delete next.origin;
    delete next.referer;
    // 这些转发类头会让"远程访问"插件判定请求来自反向代理（isProxiedRequest），
    // 从而弹出"需要设备配对"的拦截页，必须全部去掉。
    delete next['x-forwarded-host'];
    delete next['x-forwarded-for'];
    delete next['x-forwarded-proto'];
    delete next['x-real-ip'];
    delete next.forwarded;
    delete next['cf-connecting-ip'];
    delete next['cf-ray'];
    delete next['cf-ipcountry'];
    const { name, value } = authCookie(targetAuthority);
    const existing = next.cookie;
    const kept = typeof existing === 'string'
        ? existing.split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith(`${name}=`))
        : [];
    kept.push(`${name}=${value}`);
    next.cookie = kept.join('; ');
    return next;
}

// ---------- 发现 DSH 回环端口 ----------
let cache = { port: 0, at: 0 };

function run(file, argv) {
    return new Promise((resolve, reject) => {
        execFile(file, argv, { encoding: 'utf8', windowsHide: true, timeout: 10000 }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout ?? '');
        });
    });
}

async function dshPids() {
    const out = await run('tasklist', ['/FI', `IMAGENAME eq ${process.env.GATE_PROCESS || 'DeepSeek Harness.exe'}`, '/FO', 'CSV', '/NH']);
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
        const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (match && match[1].toLowerCase() === (process.env.GATE_PROCESS || 'DeepSeek Harness.exe').toLowerCase()) pids.add(match[2]);
    }
    return pids;
}

async function resolveTargetPort() {
    if (FIXED_TARGET) return Number(FIXED_TARGET);
    const now = Date.now();
    if (cache.port && now - cache.at < 3000) return cache.port;
    try {
        const pids = await dshPids();
        const out = await run('netstat', ['-ano', '-p', 'TCP']);
        for (const line of out.split(/\r?\n/)) {
            const match = /^\s*TCP\s+(127\.0\.0\.1|0\.0\.0\.0):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
            if (!match || !pids.has(match[3])) continue;
            cache = { port: Number(match[2]), at: now };
            return cache.port;
        }
    } catch (error) {
        log(`发现 DSH 端口失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return cache.port;
}

// ---------- HTTP 代理（补 Cookie） ----------
const server = http.createServer((req, res) => {
    void (async () => {
        const port = await resolveTargetPort();
        if (!port) {
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('DSH 没在运行（找不到监听端口）\n');
            return;
        }
        const originalAuthority = req.headers.host ?? `${LISTEN_HOST}:${LISTEN_PORT}`;
        const targetAuthority = `127.0.0.1:${port}`;
        const upstream = http.request({
            host: TARGET_HOST,
            port,
            method: req.method,
            path: req.url,
            headers: rewriteHeaders(req.headers, originalAuthority, targetAuthority),
        }, (upstreamRes) => {
            // 客户端不缓存任何东西，避免手机浏览器拿旧页面
            const headers = { ...upstreamRes.headers };
            delete headers.etag;
            delete headers['last-modified'];
            headers['cache-control'] = 'no-store';
            log(`${req.method} ${String(req.url)} host=${originalAuthority} -> ${upstreamRes.statusCode}`);
            res.writeHead(upstreamRes.statusCode ?? 502, headers);
            upstreamRes.pipe(res);
        });
        upstream.on('error', (error) => {
            log(`转发失败：${error.message}`);
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('网关转发失败\n');
        });
        req.pipe(upstream);
    })();
});

// ---------- WebSocket / Upgrade 代理（补 Cookie） ----------
server.on('upgrade', (req, socket, head) => {
    void (async () => {
        const port = await resolveTargetPort();
        if (!port) {
            socket.destroy();
            return;
        }
        const originalAuthority = req.headers.host ?? `${LISTEN_HOST}:${LISTEN_PORT}`;
        const targetAuthority = `127.0.0.1:${port}`;
        const upstreamHeaders = rewriteHeaders(req.headers, originalAuthority, targetAuthority);
        const upstream = net.connect({ host: TARGET_HOST, port }, () => {
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            for (const [key, value] of Object.entries(upstreamHeaders)) {
                if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
                else if (value !== undefined) lines.push(`${key}: ${value}`);
            }
            upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (head && head.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        const close = () => {
            socket.destroy();
            upstream.destroy();
        };
        socket.on('error', close);
        upstream.on('error', close);
    })();
});

server.on('error', (error) => {
    log(`监听 ${LISTEN_HOST}:${LISTEN_PORT} 失败：${error.message}`);
    process.exitCode = 1;
});

server.listen(LISTEN_PORT, LISTEN_HOST, async () => {
    log(`鉴权网关已启动：${LISTEN_HOST}:${LISTEN_PORT} → ${TARGET_HOST}:${FIXED_TARGET || '(自动发现 DSH 端口)'}`);
    const port = await resolveTargetPort();
    log(port ? `当前 DSH 回环端口：${port}` : '暂时没找到 DSH 端口（收到请求时会再找）');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        log(`收到 ${signal}，退出`);
        server.close(() => process.exit(0));
    });
}
