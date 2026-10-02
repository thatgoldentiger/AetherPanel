const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const multer = require('multer');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.PANEL_PASSWORD || '';
const SERVERS = path.join(__dirname, 'data', 'servers');
const CONFIG = path.join(__dirname, 'data', 'config.json');

if (!PASSWORD) {
    console.error('PANEL_PASSWORD is not set. Start with: PANEL_PASSWORD=yourpass node server.js');
    process.exit(1);
}
fs.ensureDirSync(SERVERS);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const load = () => (fs.existsSync(CONFIG) ? fs.readJsonSync(CONFIG) : []);
const save = (s) => fs.writeJsonSync(CONFIG, s, { spaces: 2 });
const find = (id) => load().find((s) => s.id === id);
const procs = new Map();      // id -> child process
const logs = new Map();       // id -> array of recent output chunks
const installing = new Set(); // ids currently downloading a jar

// Resolve a user-supplied relative path inside a server folder; null if it escapes.
function safe(id, rel = '') {
    const base = path.resolve(SERVERS, id);
    const p = path.resolve(base, '.' + path.sep + String(rel));
    return p === base || p.startsWith(base + path.sep) ? p : null;
}

function send(id, msg) {
    const m = JSON.stringify(msg);
    wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN && c.serverId === id) c.send(m); });
}
function log(id, text) {
    const a = logs.get(id) || [];
    a.push(text);
    if (a.length > 500) a.shift();
    logs.set(id, a);
    send(id, { type: 'log', data: text });
}
const statusOf = (id) => (installing.has(id) ? 'INSTALLING' : procs.has(id) ? 'ONLINE' : 'OFFLINE');

// ---------- auth ----------
const tokens = new Map();
const fails = new Map();
const hash = (s) => crypto.createHash('sha256').update(s).digest();
const valid = (t) => !!t && tokens.has(t) && tokens.get(t) > Date.now();

app.post('/api/login', (req, res) => {
    const ip = req.ip;
    const f = fails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 5) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
    const ok = crypto.timingSafeEqual(hash(String((req.body || {}).password || '')), hash(PASSWORD));
    if (!ok) { f.n++; fails.set(ip, f); return res.status(401).json({ error: 'Wrong password' }); }
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, Date.now() + 24 * 3600 * 1000);
    res.json({ token });
});

app.use('/api', (req, res, next) => (valid(req.headers['x-token']) ? next() : res.status(401).json({ error: 'Unauthorized' })));

app.param('id', (req, res, next, id) => {
    if (!/^srv-\d+$/.test(id) || !find(id)) return res.status(404).json({ error: 'Server not found' });
    next();
});

// ---------- process control ----------
function start(s) {
    if (procs.has(s.id)) return 'Server is already running';
    if (installing.has(s.id)) return 'Server files are still being downloaded';
    const child = spawn('exec ' + s.startCmd, { cwd: safe(s.id), shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.started = Date.now();
    procs.set(s.id, child);
    const out = (d) => log(s.id, d.toString());
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.stdin.on('error', () => {});
    child.on('error', (e) => log(s.id, `[System] Failed to start: ${e.message}\n`));
    child.on('close', (code, sig) => {
        procs.delete(s.id);
        log(s.id, `\n[System] Process exited (code ${code}${sig ? ', signal ' + sig : ''})\n`);
        send(s.id, { type: 'status' });
    });
    log(s.id, `[System] Starting: ${s.startCmd}\n`);
    send(s.id, { type: 'status' });
    return null;
}

function stop(s, force) {
    return new Promise((resolve) => {
        const c = procs.get(s.id);
        if (!c) return resolve();
        c.once('close', resolve);
        if (force) return c.kill('SIGKILL');
        if (s.game === 'minecraft') { try { c.stdin.write('stop\n'); } catch (e) {} } else c.kill('SIGTERM');
        setTimeout(() => procs.has(s.id) && c.kill('SIGTERM'), 15000);
        setTimeout(() => procs.has(s.id) && c.kill('SIGKILL'), 30000);
    });
}

async function installPaper(s) {
    installing.add(s.id);
    send(s.id, { type: 'status' });
    try {
        log(s.id, `[System] Looking up Paper ${s.version}...\n`);
        const headers = { 'User-Agent': 'AetherPanel/1.0' };
        const r = await fetch(`https://fill.papermc.io/v3/projects/paper/versions/${s.version}/builds`, { headers });
        if (!r.ok) throw new Error(`Paper API returned HTTP ${r.status} (is ${s.version} a valid version?)`);
        const builds = await r.json();
        const b = builds.find((x) => x.channel === 'STABLE') || builds[0];
        const url = b && b.downloads && b.downloads['server:default'] && b.downloads['server:default'].url;
        if (!url) throw new Error('No downloadable build found');
        log(s.id, `[System] Downloading ${url}\n`);
        const d = await fetch(url, { headers });
        if (!d.ok) throw new Error(`Download failed: HTTP ${d.status}`);
        await fs.writeFile(path.join(safe(s.id), 'server.jar'), Buffer.from(await d.arrayBuffer()));
        log(s.id, '[System] Paper installed. You can start the server now.\n');
    } catch (e) {
        log(s.id, `[System] Install failed: ${e.message}\n[System] Upload your own server.jar in the Files tab instead.\n`);
    }
    installing.delete(s.id);
    send(s.id, { type: 'status' });
}

// ---------- servers API ----------
app.get('/api/servers', (req, res) => res.json(load().map((s) => ({ ...s, status: statusOf(s.id) }))));

app.post('/api/servers', async (req, res) => {
    try {
        const b = req.body || {};
        const name = String(b.name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 60);
        const game = ['minecraft', 'terraria', 'valheim', 'custom'].includes(b.game) ? b.game : null;
        const port = parseInt(b.port);
        const ram = parseFloat(b.ram);
        const version = String(b.version || '').trim();
        let startCmd = String(b.startCmd || '').trim().slice(0, 500);
        if (!name || !game || !(port > 0 && port < 65536)) return res.status(400).json({ error: 'Invalid name, game or port' });
        if (game === 'minecraft') {
            if (!/^\d+\.\d+(\.\d+)?$/.test(version) || !(ram >= 0.5 && ram <= 128)) return res.status(400).json({ error: 'Invalid Minecraft version or RAM' });
            startCmd = `java -Xms512M -Xmx${Math.round(ram * 1024)}M -jar server.jar nogui`;
        } else if (!startCmd) {
            return res.status(400).json({ error: 'A start command is required for this game' });
        }
        const id = 'srv-' + Date.now();
        await fs.ensureDir(safe(id));
        if (game === 'minecraft') {
            await fs.writeFile(path.join(safe(id), 'server.properties'), `server-port=${port}\nmotd=${name}\nmax-players=20\n`);
            await fs.writeFile(path.join(safe(id), 'eula.txt'), 'eula=true\n');
        }
        const s = { id, name, game, version: game === 'minecraft' ? version : '', port, ram: ram || 0, startCmd };
        save([...load(), s]);
        if (game === 'minecraft') installPaper(s);
        res.status(201).json({ ...s, status: statusOf(id) });
    } catch (e) {
        res.status(500).json({ error: 'Failed to create server: ' + e.message });
    }
});

app.delete('/api/servers/:id', async (req, res) => {
    const s = find(req.params.id);
    await stop(s, true);
    await fs.remove(safe(s.id));
    save(load().filter((x) => x.id !== s.id));
    logs.delete(s.id);
    res.json({ ok: true });
});

app.post('/api/servers/:id/power', (req, res) => {
    const s = find(req.params.id);
    const a = (req.body || {}).action;
    if (a === 'start') {
        const err = start(s);
        return err ? res.status(400).json({ error: err }) : res.json({ ok: true });
    }
    if (a === 'stop' || a === 'kill') {
        if (!procs.has(s.id)) return res.status(400).json({ error: 'Server is not running' });
        stop(s, a === 'kill');
        return res.json({ ok: true });
    }
    if (a === 'restart') {
        stop(s, false).then(() => start(s));
        return res.json({ ok: true });
    }
    res.status(400).json({ error: 'Invalid power action' });
});

app.get('/api/servers/:id/stats', (req, res) => {
    const c = procs.get(req.params.id);
    if (!c) return res.json({ online: false });
    execFile('ps', ['-o', '%cpu=,rss=', '-p', String(c.pid)], (e, out) => {
        const [cpu, rss] = (out || '').trim().split(/\s+/);
        res.json({ online: true, cpu: parseFloat(cpu) || 0, ramMB: Math.round((parseInt(rss) || 0) / 1024), uptime: Math.floor((Date.now() - c.started) / 1000) });
    });
});

// ---------- files API ----------
app.get('/api/servers/:id/files', async (req, res) => {
    try {
        const dir = safe(req.params.id, req.query.path || '');
        if (!dir || !(await fs.pathExists(dir))) return res.status(404).json({ error: 'Directory not found' });
        const items = await fs.readdir(dir, { withFileTypes: true });
        const list = await Promise.all(items.map(async (i) => {
            const st = await fs.stat(path.join(dir, i.name));
            return { name: i.name, isDir: i.isDirectory(), size: st.size, modified: st.mtime.toISOString().replace('T', ' ').substring(0, 16) };
        }));
        list.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));
        res.json(list);
    } catch (e) { res.status(500).json({ error: 'Failed to read directory' }); }
});

app.get('/api/servers/:id/files/content', async (req, res) => {
    try {
        const f = safe(req.params.id, req.query.file || '');
        if (!f) return res.status(400).json({ error: 'Bad path' });
        const st = await fs.stat(f);
        if (!st.isFile() || st.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'Not a file, or larger than 2 MB' });
        res.json({ content: await fs.readFile(f, 'utf8') });
    } catch (e) { res.status(500).json({ error: 'Failed to read file' }); }
});

app.post('/api/servers/:id/files/save', async (req, res) => {
    try {
        const f = safe(req.params.id, (req.body || {}).filePath || '');
        if (!f || f === safe(req.params.id)) return res.status(400).json({ error: 'Bad path' });
        await fs.ensureDir(path.dirname(f));
        await fs.writeFile(f, String(req.body.content ?? ''), 'utf8');
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to save file' }); }
});

app.post('/api/servers/:id/files/mkdir', async (req, res) => {
    try {
        const d = safe(req.params.id, (req.body || {}).path || '');
        if (!d || d === safe(req.params.id)) return res.status(400).json({ error: 'Bad path' });
        await fs.ensureDir(d);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to create folder' }); }
});

app.delete('/api/servers/:id/files', async (req, res) => {
    try {
        const p = safe(req.params.id, req.query.path || '');
        if (!p || p === safe(req.params.id)) return res.status(400).json({ error: 'Bad path' });
        await fs.remove(p);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to delete' }); }
});

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const d = safe(req.params.id, req.query.path || '');
            if (!d) return cb(new Error('Bad path'));
            fs.ensureDir(d).then(() => cb(null, d), cb);
        },
        filename: (req, file, cb) => cb(null, path.basename(file.originalname))
    })
});
app.post('/api/servers/:id/upload', upload.array('files'), (req, res) => res.json({ ok: true, count: (req.files || []).length }));

app.use((err, req, res, next) => res.status(500).json({ error: err.message || 'Server error' }));

// ---------- websocket console ----------
wss.on('connection', (ws, req) => {
    const u = new URL(req.url, 'http://x');
    if (!valid(u.searchParams.get('token'))) return ws.close(4001, 'Unauthorized');
    const id = u.searchParams.get('serverId');
    if (!/^srv-\d+$/.test(id || '') || !find(id)) return ws.close(4004, 'Unknown server');
    ws.serverId = id;
    ws.send(JSON.stringify({ type: 'history', data: (logs.get(id) || []).join('') }));
    ws.on('message', (m) => {
        try {
            const p = JSON.parse(m);
            if (p.type !== 'command') return;
            const c = procs.get(id);
            if (c) c.stdin.write(String(p.command).replace(/[\r\n]+/g, ' ') + '\n');
            else ws.send(JSON.stringify({ type: 'log', data: '[System] Server is not running.\n' }));
        } catch (e) {}
    });
});

// Stop all game servers cleanly when the panel stops
function shutdown() {
    Promise.all(load().map((s) => stop(s, false))).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 20000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`AetherPanel running on port ${PORT}`));
