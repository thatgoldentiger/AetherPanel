const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const multer = require('multer');
const os = require('os');
const { spawn, execFile } = require('child_process');
const inst = require('./installers');
const mkPlayers = require('./players');

const PORT = process.env.PORT || 3000;
const PASS_FILE = path.join(__dirname, '.password');
const UNINSTALL = '/usr/local/sbin/aetherpanel-uninstall';
let PASSWORD = process.env.PANEL_PASSWORD || (fs.existsSync(PASS_FILE) ? fs.readFileSync(PASS_FILE, 'utf8').replace(/\r?\n$/, '') : '');
const SERVERS = path.join(__dirname, 'data', 'servers');
const CONFIG = path.join(__dirname, 'data', 'config.json');
const ICONS = path.join(__dirname, 'data', 'icons');
const NCPU = Math.max(1, os.cpus().length);

if (!PASSWORD) {
    console.error('No panel password set. Run setup.sh, or start with: PANEL_PASSWORD=yourpass node server.js');
    process.exit(1);
}
fs.ensureDirSync(SERVERS);
fs.ensureDirSync(ICONS);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/icons', express.static(ICONS));

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
const players = mkPlayers({
    safe,
    write: (id, cmd) => { const c = procs.get(id); if (c) try { c.stdin.write(cmd + '\n'); } catch (e) {} }
});

// ---------- auth ----------
const tokens = new Map();
const fails = new Map();
const hash = (s) => crypto.createHash('sha256').update(s).digest();
const eq = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const valid = (t) => !!t && tokens.has(t) && tokens.get(t) > Date.now();

app.post('/api/login', (req, res) => {
    const ip = req.ip;
    const f = fails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 5) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
    const ok = eq(String((req.body || {}).password || ''), PASSWORD);
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
    const child = spawn('exec ' + s.startCmd, { cwd: safe(s.id), shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(s.env || {}) } });
    child.started = Date.now();
    procs.set(s.id, child);
    const out = (d) => { const t = d.toString(); log(s.id, t); players.onOutput(s, t); };
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.stdin.on('error', () => {});
    child.on('error', (e) => log(s.id, `[System] Failed to start: ${e.message}\n`));
    child.on('close', (code, sig) => {
        procs.delete(s.id);
        players.onClose(s.id);
        log(s.id, `\n[System] Process exited (code ${code}${sig ? ', signal ' + sig : ''})\n`);
        send(s.id, { type: 'status' });
    });
    log(s.id, `[System] Starting: ${s.startCmd}\n`);
    send(s.id, { type: 'status' });
    return null;
}

async function runStopScript(id, c, script) {
    const lines = String(script || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (procs.get(id) !== c) return; // process already gone (closed, or replaced by a new start)
        const m = line.match(/^wait\((\d+(?:\.\d+)?)\)$/i);
        if (m) await new Promise((r) => setTimeout(r, Math.min(120, parseFloat(m[1])) * 1000));
        else try { c.stdin.write(line + '\n'); } catch (e) {}
    }
}

function stop(s, force) {
    return new Promise((resolve) => {
        const c = procs.get(s.id);
        if (!c) return resolve();
        c.once('close', resolve);
        if (force) return c.kill('SIGKILL');
        const script = s.stopCmd || { minecraft: 'stop', terraria: 'exit', tmodloader: 'exit' }[s.game] || '';
        if (script) runStopScript(s.id, c, script).catch(() => {});
        else c.kill('SIGTERM');
        setTimeout(() => procs.has(s.id) && c.kill('SIGTERM'), 25000);
        setTimeout(() => procs.has(s.id) && c.kill('SIGKILL'), 45000);
    });
}

async function installServer(s) {
    installing.add(s.id);
    send(s.id, { type: 'status' });
    const l = (t) => log(s.id, t);
    try {
        l(`[System] Installing ${s.game} ${s.engine || ''} ${s.version}...\n`);
        const result = await inst.install(s, safe(s.id), l);
        if (result && result.startCmd) {
            s.startCmd = result.startCmd;
            const all = load();
            const idx = all.findIndex((x) => x.id === s.id);
            if (idx >= 0) { all[idx].startCmd = s.startCmd; save(all); }
            l(`[System] Detected start command: ${s.startCmd}\n`);
        }
        l('[System] Installation finished. You can start the server now.\n');
    } catch (e) {
        l(`[System] Install failed: ${e.message}\n[System] You can upload files manually in the Files tab, or delete and recreate the server.\n`);
    }
    installing.delete(s.id);
    send(s.id, { type: 'status' });
}

// ---------- servers API ----------
app.get('/api/servers', (req, res) => res.json(load().map((s) => ({ ...s, status: statusOf(s.id) }))));

app.get('/api/versions', async (req, res) => {
    try { res.json(await inst.versions(String(req.query.game || ''), String(req.query.engine || ''))); }
    catch (e) { res.status(502).json({ error: 'Could not fetch version list: ' + e.message }); }
});

app.post('/api/servers', async (req, res) => {
    try {
        const b = req.body || {};
        const bad = (m) => res.status(400).json({ error: m });
        const name = String(b.name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 40);
        const game = ['minecraft', 'terraria', 'tmodloader', 'valheim', 'custom'].includes(b.game) ? b.game : null;
        const port = parseInt(b.port);
        if (!name || !game || !(port > 0 && port < 65536)) return bad('Invalid name, game or port');
        const s = { id: 'srv-' + Date.now(), name, game, engine: '', version: '', port, ram: parseFloat(b.ram) || 0, startCmd: '', env: {} };
        if (game === 'custom') {
            s.startCmd = String(b.startCmd || '').trim().slice(0, 500);
            s.stopCmd = '';
            if (!s.startCmd) return bad('A start command is required');
        } else {
            if (!/^[\w .-]+$/.test(name)) return bad('Name may only contain letters, numbers, spaces, dots, dashes and underscores');
            s.engine = game === 'minecraft' ? String(b.engine || '') : '';
            if (game === 'minecraft' && !inst.ENGINES.includes(s.engine)) return bad('Unknown Minecraft software');
            s.version = String(b.version || '');
            let list;
            try { list = await inst.versions(game, s.engine); } catch (e) { return bad('Could not verify version: ' + e.message); }
            if (!list.some((v) => v.value === s.version)) return bad('Unknown version');
            if (game === 'minecraft') {
                if (!(s.ram >= 0.5 && s.ram <= 128)) return bad('RAM must be between 0.5 and 128 GB');
                s.java = s.engine === 'customjar' ? ([8, 17, 21].includes(parseInt(b.java)) ? parseInt(b.java) : 21) : await inst.javaFor(s.version);
            }
            const pw = String(b.password || '').trim();
            if (game === 'valheim' && pw) {
                if (!/^[A-Za-z0-9]{5,30}$/.test(pw)) return bad('If you set a Valheim password it must be 5-30 letters/numbers');
                if (pw.toLowerCase() === 'dedicated') return bad('Valheim password cannot be the same as the world name ("Dedicated")');
            }
            const worldSize = ['small', 'medium', 'large'].includes(b.worldSize) ? b.worldSize : 'medium';
            Object.assign(s, inst.build(s, { password: pw, worldSize }));
        }
        await fs.ensureDir(safe(s.id));
        if (game === 'minecraft') {
            await fs.writeFile(path.join(safe(s.id), 'server.properties'), `server-port=${port}\nmotd=${name}\nmax-players=20\n`);
            await fs.writeFile(path.join(safe(s.id), 'eula.txt'), 'eula=true\n');
            await players.prep(s, safe(s.id));
        }
        save([...load(), s]);
        if (game !== 'custom') installServer(s);
        res.status(201).json({ ...s, status: statusOf(s.id) });
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
        const pct = Math.min(100, (parseFloat(cpu) || 0) / NCPU); // normalize a multi-threaded %cpu to a 0-100 system share
        res.json({ online: true, cpu: Math.round(pct * 10) / 10, ramMB: Math.round((parseInt(rss) || 0) / 1024), uptime: Math.floor((Date.now() - c.started) / 1000), startedAt: c.started });
    });
});

// ---------- players ----------
app.get('/api/servers/:id/players', async (req, res) => {
    try { res.json(await players.get(find(req.params.id), procs.has(req.params.id))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/servers/:id/players/action', async (req, res) => {
    try { res.json({ ok: true, message: await players.act(find(req.params.id), procs.has(req.params.id), req.body || {}) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- rename / edit commands ----------
app.patch('/api/servers/:id', async (req, res) => {
    const b = req.body || {};
    const all = load();
    const idx = all.findIndex((x) => x.id === req.params.id);
    const s = all[idx];
    if ('name' in b) {
        const name = String(b.name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 40);
        if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
        s.name = name;
    }
    if ('startCmd' in b) {
        const v = String(b.startCmd || '').trim().slice(0, 500);
        if (!v) return res.status(400).json({ error: 'Start command cannot be empty' });
        s.startCmd = v;
    }
    if ('stopCmd' in b) s.stopCmd = String(b.stopCmd || '').trim().slice(0, 200);
    all[idx] = s;
    save(all);
    res.json({ ...s, status: statusOf(s.id) });
});

// ---------- server icon ----------
const iconUpload = multer({
    limits: { fileSize: 2 * 1024 * 1024 },
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, ICONS),
        filename: (req, file, cb) => cb(null, req.params.id + (path.extname(file.originalname).toLowerCase() || '.png'))
    }),
    fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype))
});
app.post('/api/servers/:id/icon', iconUpload.single('icon'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PNG, JPG, GIF or WEBP image under 2 MB' });
    const all = load();
    const idx = all.findIndex((x) => x.id === req.params.id);
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp']) {
        if (ext !== path.extname(req.file.filename)) fs.remove(path.join(ICONS, req.params.id + ext)).catch(() => {});
    }
    all[idx].icon = `/icons/${req.file.filename}?v=${Date.now()}`;
    save(all);
    res.json({ icon: all[idx].icon });
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

app.post('/api/password', (req, res) => {
    const b = req.body || {};
    if (process.env.PANEL_PASSWORD) return res.status(400).json({ error: 'Password is set by the PANEL_PASSWORD environment variable' });
    if (!eq(String(b.current || ''), PASSWORD)) return res.status(403).json({ error: 'Current password is wrong' });
    const n = String(b.next || '');
    if (n.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    fs.writeFileSync(PASS_FILE, n, { mode: 0o600 });
    PASSWORD = n;
    tokens.clear();
    res.json({ ok: true });
});

app.post('/api/uninstall', (req, res) => {
    const b = req.body || {};
    if (!eq(String(b.password || ''), PASSWORD)) return res.status(403).json({ error: 'Wrong password' });
    if (!fs.existsSync(UNINSTALL)) return res.status(501).json({ error: 'Uninstaller not found. Run uninstall.sh from a terminal instead.' });
    execFile('sudo', ['-n', UNINSTALL, '--yes'].concat(b.keepData ? ['--keep-data'] : []), (err, out, errOut) => {
        if (err) return res.status(500).json({ error: 'Could not start uninstall: ' + (errOut || err.message) });
        res.json({ ok: true });
    });
});

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
