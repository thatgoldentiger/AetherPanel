const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const MCNAME = /^[\w.\-]{1,32}$/;
const TNAME = /^[\w.\- ]{1,32}$/;
const ID = /^[\w.\-]{1,40}$/;
const clean = (t) => String(t).replace(/\u00a7./g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();

const captures = new Map(); // server id -> [{t}] buffers collecting console output
const vplayers = new Map(); // valheim: server id -> Map(steamId -> name)
const lastSid = new Map();
const tpsCache = new Map();

// Minimal Minecraft RCON client (localhost only)
function rcon(port, pass, cmd, timeout = 4000) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        let buf = Buffer.alloc(0), step = 0;
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('RCON timeout')); }, timeout);
        const pkt = (id, type, body) => {
            const b = Buffer.from(body, 'utf8'), p = Buffer.alloc(14 + b.length);
            p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12);
            return p;
        };
        sock.on('connect', () => sock.write(pkt(1, 3, pass)));
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 4) {
                const len = buf.readInt32LE(0);
                if (buf.length < len + 4) break;
                const id = buf.readInt32LE(4), body = buf.toString('utf8', 12, len + 2);
                buf = buf.slice(len + 4);
                if (step === 0) {
                    if (id === -1) { clearTimeout(timer); sock.destroy(); return reject(new Error('RCON auth failed')); }
                    step = 1; sock.write(pkt(2, 2, cmd));
                } else { clearTimeout(timer); sock.end(); return resolve(body); }
            }
        });
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

module.exports = (ctx) => {
    const rc = (s, cmd) => rcon(s.rconPort, s.rconPass, cmd);
    const readJson = async (f) => { try { const j = await fs.readJson(f); return Array.isArray(j) ? j : []; } catch (e) { return []; } };
    const readLines = async (f) => { try { return (await fs.readFile(f, 'utf8')).split(/\r?\n/); } catch (e) { return []; } };
    const vdir = (s) => {
        const d = path.join(ctx.safe(s.id), 'save');
        return fs.existsSync(d) ? d : path.join(process.env.HOME || '/opt/aetherpanel', '.config/unity3d/IronGate/Valheim');
    };
    const knownFile = (s) => path.join(ctx.safe(s.id), 'aether-players.json');
    const known = async (s) => { try { return await fs.readJson(knownFile(s)); } catch (e) { return {}; } };
    const remember = async (s, sid, name) => { const k = await known(s); k[sid] = name; await fs.writeJson(knownFile(s), k).catch(() => {}); };

    function capture(id, cmd, ms) {
        return new Promise((resolve) => {
            const b = { t: '' };
            captures.set(id, [...(captures.get(id) || []), b]);
            ctx.write(id, cmd);
            setTimeout(() => { captures.set(id, (captures.get(id) || []).filter((x) => x !== b)); resolve(b.t); }, ms);
        });
    }

    // Add (add=true) or remove an ID line in a list file
    async function listEdit(file, id, add, pairComment) {
        let lines = (await fs.pathExists(file)) ? (await fs.readFile(file, 'utf8')).split(/\r?\n/) : ["//List IDs, ONE per line"];
        if (add) { if (!lines.some((l) => l.trim() === id)) lines.push(id); }
        else lines = lines.filter((l, i) => l.trim() !== id && !(pairComment && l.trim().startsWith('//') && (lines[i + 1] || '').trim() === id));
        await fs.ensureDir(path.dirname(file));
        await fs.writeFile(file, lines.join('\n').replace(/\n*$/, '\n'));
    }

    // Make sure a Minecraft server has RCON enabled (localhost use only) before it starts
    async function prep(s, dir) {
        let changed = false;
        if (!s.rconPass) { s.rconPass = crypto.randomBytes(12).toString('hex'); changed = true; }
        if (!s.rconPort) { s.rconPort = 30000 + Math.floor(Math.random() * 10000); changed = true; }
        const f = path.join(dir, 'server.properties');
        let t = (await fs.pathExists(f)) ? await fs.readFile(f, 'utf8') : '';
        const want = { 'enable-rcon': 'true', 'rcon.port': s.rconPort, 'rcon.password': s.rconPass, 'broadcast-rcon-to-ops': 'false' };
        for (const [k, v] of Object.entries(want)) {
            const re = new RegExp('^' + k.replace(/\./g, '\\.') + '=.*$', 'm');
            t = re.test(t) ? t.replace(re, `${k}=${v}`) : t + (t && !t.endsWith('\n') ? '\n' : '') + `${k}=${v}\n`;
        }
        await fs.writeFile(f, t);
        return changed;
    }

    function onOutput(s, text) {
        (captures.get(s.id) || []).forEach((b) => (b.t += text));
        if (s.game !== 'valheim') return;
        const m = vplayers.get(s.id) || new Map();
        vplayers.set(s.id, m);
        for (const line of text.split('\n')) {
            let x;
            if ((x = line.match(/Got connection SteamID (\S+)/))) lastSid.set(s.id, x[1].replace(/^Steam_/, ''));
            else if ((x = line.match(/Got character ZDOID from (.+?) : (-?\d+):(-?\d+)/))) {
                const sid = lastSid.get(s.id);
                if (sid && ![...m.values()].includes(x[1])) { m.set(sid, x[1]); remember(s, sid, x[1]); }
            } else if ((x = line.match(/Closing socket (\S+)/))) m.delete(x[1].replace(/^Steam_/, ''));
        }
    }
    const onClose = (id) => { vplayers.delete(id); lastSid.delete(id); captures.delete(id); tpsCache.delete(id); };

    async function tps(s) {
        if (s.game !== 'minecraft' || !s.rconPort) return null;
        const c = tpsCache.get(s.id);
        if (c && Date.now() - c.t < 4000) return c.v;
        let v = null;
        try {
            if (s.engine !== 'vanilla' && s.engine !== 'fabric') {
                const m = clean(await rc(s, 'tps')).match(/:\s*\*?([\d.]+)/);
                if (m) v = Math.min(20, parseFloat(m[1]));
            }
            if (v === null) {
                const m = clean(await rc(s, 'tick query')).match(/Average time per tick:\s*([\d.]+)\s*ms/i);
                if (m) v = Math.min(20, 1000 / Math.max(parseFloat(m[1]), 1));
            }
        } catch (e) { v = null; }
        if (v !== null) v = Math.round(v * 10) / 10;
        tpsCache.set(s.id, { t: Date.now(), v });
        return v;
    }

    async function get(s, running) {
        const dir = ctx.safe(s.id);
        const r = { caps: {}, online: [], ops: [], bans: [], tps: null, note: '', opsLabel: 'Operators' };
        if (s.game === 'minecraft') {
            r.caps = { kick: true, ban: true, op: true, reason: true };
            r.ops = (await readJson(path.join(dir, 'ops.json'))).map((o) => ({ name: o.name, id: o.name, info: 'level ' + o.level }));
            r.bans = (await readJson(path.join(dir, 'banned-players.json'))).map((b) => ({ name: b.name, id: b.name, info: b.reason || '' }));
            if (!running) r.note = 'Start the server to see online players and manage them.';
            else try {
                const text = clean(await rc(s, 'list'));
                const m = text.match(/online:?\s*([\s\S]*)$/i);
                r.online = (m ? m[1].split(',') : []).map((n) => n.trim()).filter((n) => MCNAME.test(n)).map((n) => ({ name: n, id: n, info: '' }));
                r.tps = await tps(s);
            } catch (e) { r.note = 'Waiting for the server console to come up (' + e.message + ')'; }
        } else if (s.game === 'terraria') {
            r.caps = { kick: true, ban: true, op: false, reason: false };
            const lines = await readLines(path.join(dir, 'banlist.txt'));
            let name = '';
            for (const raw of lines) {
                const l = raw.trim();
                if (!l) continue;
                if (l.startsWith('//')) name = l.slice(2).trim();
                else { r.bans.push({ name: name || l, id: l, info: name ? l : '' }); name = ''; }
            }
            if (!running) r.note = 'Start the server to see online players.';
            else {
                const text = await capture(s.id, 'playing', 1500);
                const re = /^[:>\s]*(.+?) \(([^()\s]+):(\d+)\)\s*$/;
                r.online = text.split(/\r?\n/).map((l) => l.match(re)).filter(Boolean).map((m) => ({ name: m[1].trim(), id: m[1].trim(), info: m[2] }));
            }
            r.note = (r.note + ' Terraria has no operators and no kick/ban reasons. Unbanning a player while the server runs may need a restart.').trim();
        } else if (s.game === 'valheim') {
            r.caps = { kick: false, ban: true, op: true, reason: false };
            r.opsLabel = 'Admins';
            const names = await known(s), d = vdir(s);
            const mk = (id) => ({ name: names[id.replace(/^Steam_/, '')] || id, id, info: id });
            r.ops = (await readLines(path.join(d, 'adminlist.txt'))).map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).map(mk);
            r.bans = (await readLines(path.join(d, 'bannedlist.txt'))).map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).map(mk);
            r.online = running ? [...(vplayers.get(s.id) || new Map())].map(([sid, name]) => ({ name, id: sid, info: sid })) : [];
            r.note = running ? 'Valheim has no kick command; banning blocks the player (they may need to reconnect to be removed). Players appear once they have fully joined.' : 'Start the server to see online players.';
        } else r.note = 'Player management is not available for custom servers.';
        return r;
    }

    async function act(s, running, b) {
        const a = String(b.action || ''), name = String(b.name || ''), id = String(b.id || name);
        const reason = String(b.reason || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
        const dir = ctx.safe(s.id);
        if (s.game === 'minecraft') {
            if (!running) throw new Error('Start the server first');
            if (!MCNAME.test(name)) throw new Error('Invalid player name');
            if (!['kick', 'ban', 'op', 'deop', 'pardon'].includes(a)) throw new Error('Unknown action');
            const out = clean(await rc(s, `${a} ${name}${reason && (a === 'kick' || a === 'ban') ? ' ' + reason : ''}`));
            return out || 'Done';
        }
        if (s.game === 'terraria') {
            if (a === 'pardon') { await listEdit(path.join(dir, 'banlist.txt'), id, false, true); return 'Removed from ban list'; }
            if (!running) throw new Error('Start the server first');
            if (!TNAME.test(name) || !['kick', 'ban'].includes(a)) throw new Error('Invalid request');
            ctx.write(s.id, `${a} ${name}`);
            return `${a} sent for ${name}`;
        }
        if (s.game === 'valheim') {
            if (!ID.test(id)) throw new Error('Invalid player ID');
            const d = vdir(s), sid = id.replace(/^Steam_/, '');
            if (a === 'op') await listEdit(path.join(d, 'adminlist.txt'), sid, true);
            else if (a === 'deop') await listEdit(path.join(d, 'adminlist.txt'), id, false);
            else if (a === 'ban') await listEdit(path.join(d, 'bannedlist.txt'), sid, true);
            else if (a === 'pardon') await listEdit(path.join(d, 'bannedlist.txt'), id, false);
            else throw new Error('Not supported on Valheim');
            return 'Done (Valheim picks up list changes within a short time)';
        }
        throw new Error('Not available for this server type');
    }

    return { get, act, tps, prep, onOutput, onClose };
};
