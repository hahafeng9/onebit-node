// onebit-node — single-file proxy node app for OneBit Deploy (Node.js PaaS).
//
// One Node process:
//   - HTTP server on $PORT (platform-injected, listens 0.0.0.0):
//       GET /health        -> 200 JSON
//       GET /<SUB_PATH>    -> base64 subscription (VLESS+WS link)
//   - xray-core child process: VLESS+WS inbound on 127.0.0.1:18001
//     (reached from outside only through the Cloudflare fixed tunnel).
//   - cloudflared child process: fixed tunnel, forced --protocol http2.
//   - Nezha agent child process (monitoring, fleet panel).
// Every child is optional and supervised: if its env vars are missing or the
// download/start fails, the child is skipped/restarted and the main HTTP
// service keeps running. ALL secrets/UUIDs/tokens come from env vars only;
// nothing secret is written in this file.
//
// Env vars:
//   PORT             - injected by OneBit (HTTP listen port)
//   UUID             - node UUID for the VLESS inbound and the sub link
//   WS_PATH          - WebSocket path, e.g. /onebit-xxxx (default /onebit)
//   NODE_DOMAIN      - tunnel hostname used in the sub link (sni/host)
//   NODE_ADDR        - optional connection address for the link
//                      (default: NODE_DOMAIN; use a CF preferred domain if set)
//   SUB_PATH         - subscription path without slashes (default: sub)
//   CF_TUNNEL_TOKEN  - Cloudflare fixed-tunnel token (enables cloudflared)
//   NZ_SERVER        - Nezha panel address, host:port
//   NZ_CLIENT_SECRET - Nezha client secret (enables the agent)
//   NZ_UUID          - stable Nezha agent uuid
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP = 'onebit-node';
const PORT = parseInt(process.env.PORT || '3000', 10);
const XRAY_PORT = 18001; // loopback only; the CF tunnel ingress points here
const startedAt = new Date().toISOString();
const WORKDIR = path.join(os.tmpdir(), 'onebit-node-runtime');
fs.mkdirSync(WORKDIR, { recursive: true });

const UUID = (process.env.UUID || '').trim();
const WS_PATH_RAW = (process.env.WS_PATH || '/onebit').trim();
const WS_PATH = WS_PATH_RAW.startsWith('/') ? WS_PATH_RAW : '/' + WS_PATH_RAW;
const SUB_PATH = (process.env.SUB_PATH || 'sub').trim().replace(/^\/+|\/+$/g, '') || 'sub';
const NODE_DOMAIN = (process.env.NODE_DOMAIN || '').trim();
const NODE_ADDR = (process.env.NODE_ADDR || '').trim() || NODE_DOMAIN;

function log(tag, msg) {
  console.log(`[${APP}][${tag}] ${msg}`);
}

// ---- subscription link ----
function buildSubBase64() {
  const domain = NODE_DOMAIN || 'example.com';
  const addr = NODE_ADDR || domain;
  const id = UUID || crypto.randomUUID();
  const link =
    `vless://${id}@${addr}:443?encryption=none&security=tls&sni=${domain}` +
    `&fp=chrome&type=ws&host=${domain}&path=${encodeURIComponent(WS_PATH)}#OneBit-VLESS`;
  return Buffer.from(link + '\n', 'utf8').toString('base64');
}

// ---- HTTP server (health + subscription only) ----
function handler(req, res) {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { /* keep '/' */ }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: APP, startedAt, uptimeSec: Math.round(process.uptime()) }));
    return;
  }
  if (pathname === '/' + SUB_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(buildSubBase64());
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
}

const server = http.createServer(handler);
server.listen(PORT, '0.0.0.0', () => {
  log('http', `listening on 0.0.0.0:${PORT} (OneBit PORT, started ${startedAt})`);
  log('http', `subscription path /${SUB_PATH}; xray loopback port ${XRAY_PORT}`);
  if (!UUID) log('http', 'WARNING: UUID env not set; sub link uses a random uuid and xray is skipped');
  if (!NODE_DOMAIN) log('http', 'WARNING: NODE_DOMAIN env not set; sub link uses example.com placeholder');
});

setInterval(() => {
  log('tick', `alive ${new Date().toISOString()} uptime ${Math.round(process.uptime())}s`);
}, 60000);

// ---- helpers ----
// Download with Node https, following redirects (no curl/wget dependency).
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'onebit-node/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return download(next, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => {
        ws.close(() => {
          const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
          if (size === 0) return reject(new Error(`empty download for ${url}`));
          resolve();
        });
      });
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('download timeout')));
  });
}

// Pure-Node zip extraction driven by the central directory (robust for the
// GitHub release zips; no unzip/python dependency on the PaaS). Extracts only
// entries whose name matches `predicate(name)`; returns extracted file names.
function extractZip(zipPath, destDir, predicate) {
  const buf = fs.readFileSync(zipPath);
  // Find End Of Central Directory record (scan the tail for PK\x05\x06).
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const extracted = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: bad central header');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !predicate(name)) continue;
    // Local header: data starts after its own name/extra fields.
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataOff, dataOff + compSize);
    let data;
    if (method === 8) data = zlib.inflateRawSync(comp);
    else if (method === 0) data = Buffer.from(comp);
    else throw new Error(`zip: unsupported method ${method} for ${name}`);
    if (data.length !== rawSize) throw new Error(`zip: size mismatch for ${name}`);
    const out = path.join(destDir, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    extracted.push(name);
  }
  return extracted;
}

function spawnSupervised(name, cmd, args, logFile) {
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  let backoff = 5;
  const start = () => {
    log(name, `starting: ${cmd} ${args.join(' ')}`);
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log(name, `spawn error: ${err.message}; retry in ${backoff}s`);
      setTimeout(start, backoff * 1000);
      backoff = Math.min(backoff * 2, 300);
      return;
    }
    if (proc.stdout) proc.stdout.pipe(logStream, { end: false });
    if (proc.stderr) proc.stderr.pipe(logStream, { end: false });
    proc.on('error', (err) => {
      log(name, `spawn error: ${err.message}; retry in ${backoff}s`);
      setTimeout(start, backoff * 1000);
      backoff = Math.min(backoff * 2, 300);
    });
    proc.on('exit', (code) => {
      log(name, `exited (code ${code}); restart in ${backoff}s`);
      setTimeout(start, backoff * 1000);
      backoff = Math.min(backoff * 2, 300);
    });
    proc.on('spawn', () => { backoff = 5; });
  };
  start();
}

// ---- xray-core (VLESS+WS on 127.0.0.1:18001) ----
async function startXray() {
  if (!UUID) { log('xray', 'UUID not set, skipping xray'); return; }
  const dir = path.join(WORKDIR, 'xray');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'xray');
  try {
    if (!fs.existsSync(bin)) {
      const version = (process.env.XRAY_VERSION || 'v26.10.31').trim();
      const asset = os.arch() === 'arm64' ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
      const url = `https://github.com/XTLS/Xray-core/releases/download/${version}/${asset}`;
      const zip = path.join(dir, 'xray.zip');
      log('xray', `downloading ${url}`);
      await download(url, zip);
      // Only the binary is needed; skip the large geo data files.
      const got = extractZip(zip, dir, (name) => name === 'xray');
      if (!got.length) throw new Error('xray binary not found in zip');
      fs.chmodSync(bin, 0o755);
      try { fs.unlinkSync(zip); } catch (e) { /* ignore */ }
      log('xray', 'binary ready');
    }
    const cfg = {
      log: { loglevel: 'warning' },
      inbounds: [{
        port: XRAY_PORT,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: { clients: [{ id: UUID, flow: '' }], decryption: 'none' },
        streamSettings: { network: 'ws', wsSettings: { path: WS_PATH } },
      }],
      outbounds: [
        { protocol: 'freedom', tag: 'direct' },
        { protocol: 'blackhole', tag: 'block' },
      ],
    };
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    log('xray', `starting VLESS+WS on 127.0.0.1:${XRAY_PORT} path ${WS_PATH}`);
    spawnSupervised('xray', bin, ['run', '-c', cfgPath], path.join(dir, 'xray.log'));
  } catch (e) {
    log('xray', `setup failed: ${e.message} (main HTTP keeps running)`);
  }
}

// ---- cloudflared (fixed tunnel, http2 forced) ----
async function startTunnel() {
  const token = (process.env.CF_TUNNEL_TOKEN || '').trim();
  if (!token) { log('tunnel', 'CF_TUNNEL_TOKEN not set, skipping cloudflared'); return; }
  const dir = path.join(WORKDIR, 'cloudflared');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'cloudflared');
  try {
    if (!fs.existsSync(bin)) {
      const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
      const version = (process.env.CF_VERSION || '2026.10.7').trim();
      const url = `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-${arch}`;
      log('tunnel', `downloading ${url}`);
      await download(url, bin);
      fs.chmodSync(bin, 0o755);
      log('tunnel', 'cloudflared binary ready');
    }
    // Tunnel ingress (configured in the CF dashboard) should point the node
    // hostname at http://localhost:18001 (xray) and the subscription hostname
    // at http://localhost:<PORT> (this app's /<SUB_PATH>).
    log('tunnel', 'starting fixed tunnel (protocol http2)');
    spawnSupervised('tunnel', bin,
      ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', token],
      path.join(dir, 'cloudflared.log'));
  } catch (e) {
    log('tunnel', `setup failed: ${e.message} (main HTTP keeps running)`);
  }
}

// ---- Nezha agent ----
async function startNezha() {
  const secret = (process.env.NZ_CLIENT_SECRET || '').trim();
  if (!secret) { log('nezha', 'NZ_CLIENT_SECRET not set, skipping agent'); return; }
  const nzServer = (process.env.NZ_SERVER || '').trim();
  if (!nzServer) { log('nezha', 'NZ_SERVER not set, skipping agent'); return; }
  const uuid = (process.env.NZ_UUID || '').trim() || crypto.randomUUID();
  const version = (process.env.NZ_VERSION || 'v2.4.0').trim();
  const dir = path.join(WORKDIR, 'nezha-agent');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'nezha-agent');
  const cfg = path.join(dir, 'config.yml');
  try {
    if (!fs.existsSync(bin)) {
      const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
      // v2.4.0 ships Linux assets as .zip (not .tar.gz).
      const url = `https://github.com/nezhahq/agent/releases/download/${version}/nezha-agent_linux_${arch}.zip`;
      const zip = path.join(dir, 'agent.zip');
      log('nezha', `downloading ${url}`);
      await download(url, zip);
      const got = extractZip(zip, dir, (name) => name === 'nezha-agent');
      if (!got.length) throw new Error('nezha-agent binary not found in zip');
      fs.chmodSync(bin, 0o755);
      try { fs.unlinkSync(zip); } catch (e) { /* ignore */ }
      log('nezha', 'agent binary ready');
    }
    const content =
      `client_secret: ${secret}\n` +
      `debug: false\n` +
      `disable_auto_update: true\n` +
      `disable_command_execute: true\n` +
      `server: ${nzServer}\n` +
      `tls: true\n` +
      `uuid: ${uuid}\n`;
    if (!fs.existsSync(cfg) || fs.readFileSync(cfg, 'utf8') !== content) {
      fs.writeFileSync(cfg, content);
    }
    log('nezha', `agent starting, server ${nzServer}, uuid ${uuid}`);
    spawnSupervised('nezha', bin, ['-c', cfg], path.join(dir, 'agent.log'));
  } catch (e) {
    log('nezha', `setup failed: ${e.message} (main HTTP keeps running)`);
  }
}

startXray();
startTunnel();
startNezha();

process.on('SIGTERM', () => {
  log('main', 'SIGTERM, shutting down');
  server.close(() => process.exit(0));
});
