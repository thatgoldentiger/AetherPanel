const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const JAVA_DIR = path.join(__dirname, 'data', 'java');
const STEAMCMD = '/opt/steamcmd/steamcmd.sh';
const UA = { 'User-Agent': 'AetherPanel/2.0' };
const cache = new Map();
const javaLocks = new Map();

async function jget(url) {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return r.json();
}
async function cached(key, fn) {
    const c = cache.get(key);
    if (c && Date.now() - c.t < 15 * 60 * 1000) return c.v;
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    return v;
}
async function download(url, dest) {
    const r = await fetch(url, { headers: UA, redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error(`Download failed (HTTP ${r.status}) from ${url}`);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
}
function run(cmd, args, cwd, log) {
    return new Promise((resolve, reject) => {
        const c = spawn(cmd, args, { cwd });
        c.stdout.on('data', (d) => log(d.toString()));
        c.stderr.on('data', (d) => log(d.toString()));
        c.on('error', reject);
        c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}`))));
    });
}
const mojang = () => cached('mojang', () => jget('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));
const javaBin = (major) => path.join(JAVA_DIR, String(major), 'bin', 'java');

// ---------- version lists (live from the official sources) ----------
async function versions(game, engine) {
    if (game === 'minecraft') {
        const releases = (await mojang()).versions.filter((v) => v.type === 'release').map((v) => v.id); // newest first
        let allowed = null;
        if (engine === 'paper') {
            const p = await cached('paper', () => jget('https://fill.papermc.io/v3/projects/paper'));
            allowed = new Set(Object.values(p.versions).flat());
        } else if (engine === 'purpur') {
            const p = await cached('purpur', () => jget('https://api.purpurmc.org/v2/purpur'));
            allowed = new Set(p.versions);
        } else if (engine === 'fabric') {
            const g = await cached('fabric', () => jget('https://meta.fabricmc.net/v2/versions/game'));
            allowed = new Set(g.filter((x) => x.stable).map((x) => x.version));
        } else if (engine !== 'vanilla') throw new Error('Unknown Minecraft software');
        return releases.filter((v) => !allowed || allowed.has(v)).map((v) => ({ value: v, label: v }));
    }
    if (game === 'terraria') {
        const names = await cached('terraria', () => jget('https://terraria.org/api/get/dedicated-servers-names'));
        return names.map((n) => {
            const num = (String(n).match(/\d{4}/) || [''])[0];
            return { value: n, label: num ? `${num[0]}.${num[1]}.${num[2]}.${num[3]} (${n.replace(/^terraria-server-|\.zip$/g, '')})` : n };
        });
    }
    if (game === 'valheim') return [{ value: 'public', label: 'Latest (Steam public branch)' }];
    throw new Error('Unknown game');
}

// Java version a given Minecraft version needs (read from Mojang's own metadata)
async function javaFor(mcVersion) {
    try {
        const e = (await mojang()).versions.find((x) => x.id === mcVersion);
        if (!e) return 21;
        const j = await cached('mc:' + mcVersion, () => jget(e.url));
        const n = (j.javaVersion && j.javaVersion.majorVersion) || 8;
        return n <= 8 ? 8 : n <= 17 ? 17 : n <= 21 ? 21 : n;
    } catch (e) { return 21; }
}

// Download a portable Java runtime (Eclipse Temurin) into data/java/<major>
function ensureJava(major, log) {
    const bin = javaBin(major);
    if (fs.existsSync(bin)) return Promise.resolve(bin);
    if (javaLocks.has(major)) return javaLocks.get(major);
    const dest = path.join(JAVA_DIR, String(major));
    const p = (async () => {
        const tmp = dest + '.tar.gz';
        try {
            await fs.ensureDir(dest);
            log(`[System] Downloading Java ${major} runtime...\n`);
            const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
            await download(`https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/${arch}/jre/hotspot/normal/eclipse`, tmp);
            await run('tar', ['xzf', tmp, '-C', dest, '--strip-components=1'], dest, () => {});
            if (!fs.existsSync(bin)) throw new Error('java binary missing after extract');
            return bin;
        } catch (e) {
            await fs.remove(dest);
            throw new Error(`Java ${major} install failed: ${e.message}`);
        } finally { await fs.remove(tmp); }
    })().finally(() => javaLocks.delete(major));
    javaLocks.set(major, p);
    return p;
}

// ---------- start commands ----------
function build(o, password) {
    const mb = Math.round(o.ram * 1024);
    if (o.game === 'minecraft') return { startCmd: `${javaBin(o.java)} -Xms${Math.min(512, mb)}M -Xmx${mb}M -jar server.jar nogui`, env: {} };
    if (o.game === 'terraria') return { startCmd: `./TerrariaServer.bin.x86_64 -port ${o.port} -maxplayers 8 -world ./worlds/world.wld -worldname "${o.name}" -autocreate 2`, env: {} };
    return {
        startCmd: `./valheim_server.x86_64 -nographics -batchmode -name "${o.name}" -port ${o.port} -world "Dedicated" -password "${password}" -public 0`,
        env: { LD_LIBRARY_PATH: './linux64', SteamAppId: '892970' }
    };
}

// ---------- game installers ----------
async function installMinecraft(s, dir, log) {
    const v = s.version;
    let url;
    if (s.engine === 'paper') {
        const b = await jget(`https://fill.papermc.io/v3/projects/paper/versions/${v}/builds`);
        const x = b.find((y) => y.channel === 'STABLE') || b[0];
        url = x && x.downloads['server:default'].url;
    } else if (s.engine === 'purpur') {
        url = `https://api.purpurmc.org/v2/purpur/${v}/latest/download`;
    } else if (s.engine === 'fabric') {
        const [l, i] = await Promise.all([jget('https://meta.fabricmc.net/v2/versions/loader'), jget('https://meta.fabricmc.net/v2/versions/installer')]);
        url = `https://meta.fabricmc.net/v2/versions/loader/${v}/${(l.find((x) => x.stable) || l[0]).version}/${(i.find((x) => x.stable) || i[0]).version}/server/jar`;
    } else {
        const e = (await mojang()).versions.find((x) => x.id === v);
        if (!e) throw new Error('Version not found at Mojang');
        url = (await jget(e.url)).downloads.server.url;
    }
    if (!url) throw new Error(`No ${s.engine} build available for ${v}`);
    log(`[System] Downloading ${s.engine} ${v}...\n`);
    await download(url, path.join(dir, 'server.jar'));
}

async function installTerraria(s, dir, log) {
    const name = s.version.endsWith('.zip') ? s.version : s.version + '.zip';
    const tmp = path.join(dir, '_dl');
    try {
        await fs.ensureDir(tmp);
        log(`[System] Downloading ${name}...\n`);
        await download(`https://terraria.org/api/download/pc-dedicated-server/${name}`, path.join(tmp, 's.zip'));
        await run('unzip', ['-oq', 's.zip'], tmp, log);
        const top = (await fs.readdir(tmp, { withFileTypes: true })).find((d) => d.isDirectory());
        if (!top) throw new Error('Unexpected zip layout');
        await fs.copy(path.join(tmp, top.name, 'Linux'), dir);
    } finally { await fs.remove(tmp); }
    for (const f of await fs.readdir(dir)) if (f.startsWith('TerrariaServer')) await fs.chmod(path.join(dir, f), 0o755);
    await fs.ensureDir(path.join(dir, 'worlds'));
}

async function installValheim(s, dir, log) {
    if (!fs.existsSync(STEAMCMD)) throw new Error('SteamCMD is not installed (re-run setup.sh)');
    const args = ['+force_install_dir', dir, '+login', 'anonymous', '+app_update', '896660', 'validate', '+quit'];
    log('[System] Downloading Valheim Dedicated Server via SteamCMD (about 1-2 GB, please wait)...\n');
    try { await run(STEAMCMD, args, path.dirname(STEAMCMD), log); }
    catch (e) { log('[System] SteamCMD failed once, retrying...\n'); await run(STEAMCMD, args, path.dirname(STEAMCMD), log); }
}

async function install(s, dir, log) {
    if (s.game === 'minecraft') { await ensureJava(s.java, log); await installMinecraft(s, dir, log); }
    else if (s.game === 'terraria') await installTerraria(s, dir, log);
    else if (s.game === 'valheim') await installValheim(s, dir, log);
}

module.exports = { versions, javaFor, ensureJava, build, install };

if (require.main === module && process.argv[2] === 'prefetch') {
    (async () => {
        for (const m of [21, 17, 8]) {
            try { await ensureJava(m, (t) => process.stdout.write(t)); } catch (e) { console.log(e.message); }
        }
    })();
}
