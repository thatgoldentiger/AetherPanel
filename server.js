const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const cors = require('cors');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SERVERS_DIR = path.join(DATA_DIR, 'servers');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure required data directories exist on start
fs.ensureDirSync(SERVERS_DIR);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeProcesses = new Map(); // Stores child processes indexed by server ID

function loadServersConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        const initialData = [
            {
                id: 'srv-1',
                name: 'Minecraft Survival',
                game: 'minecraft',
                engine: 'Paper',
                version: '1.20.4',
                port: 25565,
                ram: 4.0,
                status: 'OFFLINE',
                jarName: 'paper-1.20.4.jar',
                startCmd: 'java -Xms1024M -Xmx4096M -jar paper-1.20.4.jar nogui'
            }
        ];
        fs.writeJsonSync(CONFIG_FILE, initialData, { spaces: 2 });
        return initialData;
    }
    return fs.readJsonSync(CONFIG_FILE);
}

function saveServersConfig(servers) {
    fs.writeJsonSync(CONFIG_FILE, servers, { spaces: 2 });
}

// Get list of all registered game servers
app.get('/api/servers', (req, res) => {
    try {
        const servers = loadServersConfig();
        const updated = servers.map(s => ({
            ...s,
            status: activeProcesses.has(s.id) ? 'ONLINE' : 'OFFLINE'
        }));
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read server configs' });
    }
});

// Create and provision a new game server
app.post('/api/servers', async (req, res) => {
    try {
        const { name, game, engine, version, port, ram } = req.body;
        const servers = loadServersConfig();
        const serverId = `srv-${Date.now()}`;
        const serverDir = path.join(SERVERS_DIR, serverId);

        await fs.ensureDir(serverDir);

        let jarName = 'server.jar';
        let startCmd = '';

        if (game === 'minecraft') {
            jarName = `${engine.toLowerCase()}-${version}.jar`;
            startCmd = `java -Xms1024M -Xmx${Math.floor(ram * 1024)}M -jar ${jarName} nogui`;
            
            const props = `server-port=${port}\nmotd=${name}\nmax-players=20\nenable-rcon=false\n`;
            await fs.writeFile(path.join(serverDir, 'server.properties'), props);
            await fs.writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');
        } else if (game === 'terraria') {
            startCmd = `./TerrariaServer.bin.x86_64 -port ${port} -maxplayers 8`;
        } else if (game === 'valheim') {
            startCmd = `./valheim_server.x86_64 -name "${name}" -port ${port} -world "Dedicated" -password "secret"`;
        }

        const newServer = {
            id: serverId,
            name,
            game,
            engine,
            version,
            port: parseInt(port),
            ram: parseFloat(ram),
            status: 'OFFLINE',
            jarName,
            startCmd
        };

        servers.push(newServer);
        saveServersConfig(servers);

        res.status(201).json(newServer);
    } catch (err) {
        res.status(500).json({ error: 'Failed to provision new server' });
    }
});

app.post('/api/servers/:id/power', (req, res) => {
    const { id } = req.params;
    const { action } = req.body;
    const servers = loadServersConfig();
    const serverInfo = servers.find(s => s.id === id);

    if (!serverInfo) {
        return res.status(404).json({ error: 'Server not found' });
    }

    const serverDir = path.join(SERVERS_DIR, id);

    if (action === 'start') {
        if (activeProcesses.has(id)) {
            return res.status(400).json({ error: 'Server is already running' });
        }

        const parts = serverInfo.startCmd.split(' ');
        const cmd = parts[0];
        const args = parts.slice(1);

        try {
            const child = spawn(cmd, args, { cwd: serverDir, shell: true });
            activeProcesses.set(id, child);

            child.stdout.on('data', (data) => broadcastLog(id, data.toString()));
            child.stderr.on('data', (data) => broadcastLog(id, `[STDERR] ${data.toString()}`));

            child.on('close', (code) => {
                broadcastLog(id, `[System] Server process terminated with exit code ${code}`);
                activeProcesses.delete(id);
            });

            return res.json({ status: 'ONLINE', message: 'Process started successfully' });
        } catch (err) {
            return res.status(500).json({ error: `Failed to launch process: ${err.message}` });
        }
    } else if (action === 'stop' || action === 'kill') {
        const child = activeProcesses.get(id);
        if (child) {
            if (action === 'stop') {
                child.stdin.write('stop\n');
                setTimeout(() => {
                    if (activeProcesses.has(id)) child.kill('SIGTERM');
                }, 10000);
            } else {
                child.kill('SIGKILL');
            }
            activeProcesses.delete(id);
            return res.json({ status: 'OFFLINE', message: 'Process stopped' });
        }
        return res.status(400).json({ error: 'Server is not currently running' });
    }

    res.status(400).json({ error: 'Invalid power action' });
});

// List directory files
app.get('/api/servers/:id/files', async (req, res) => {
    try {
        const { id } = req.params;
        const subPath = req.query.path || '';
        const targetDir = path.join(SERVERS_DIR, id, path.normalize(subPath).replace(/^(\.\.[\/\\])+/, ''));

        if (!fs.existsSync(targetDir)) {
            return res.status(404).json({ error: 'Directory not found' });
        }

        const items = await fs.readdir(targetDir, { withFileTypes: true });
        const fileList = await Promise.all(items.map(async (item) => {
            const fullPath = path.join(targetDir, item.name);
            const stats = await fs.stat(fullPath);
            return {
                name: item.name,
                isDir: item.isDirectory(),
                size: item.isDirectory() ? '--' : `${(stats.size / 1024).toFixed(1)} KB`,
                modified: stats.mtime.toISOString().replace('T', ' ').substring(0, 16)
            };
        }));

        res.json(fileList);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read directory' });
    }
});

// Read file text content
app.get('/api/servers/:id/files/content', async (req, res) => {
    try {
        const { id } = req.params;
        const filePath = req.query.file;
        const targetFile = path.join(SERVERS_DIR, id, path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));

        const content = await fs.readFile(targetFile, 'utf8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read file content' });
    }
});

// Save file text content
app.post('/api/servers/:id/files/save', async (req, res) => {
    try {
        const { id } = req.params;
        const { filePath, content } = req.body;
        const targetFile = path.join(SERVERS_DIR, id, path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));

        await fs.writeFile(targetFile, content, 'utf8');
        res.json({ success: true, message: 'File saved successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save file' });
    }
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const serverId = req.params.id;
        const uploadPath = path.join(SERVERS_DIR, serverId);
        fs.ensureDirSync(uploadPath);
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

app.post('/api/servers/:id/upload', upload.array('files'), (req, res) => {
    res.json({ success: true, count: req.files ? req.files.length : 0 });
});

function broadcastLog(serverId, text) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.serverId === serverId) {
            client.send(JSON.stringify({ type: 'log', data: text }));
        }
    });
}

wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.replace('/?', ''));
    const serverId = urlParams.get('serverId');
    ws.serverId = serverId;

    ws.on('message', (message) => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.type === 'command') {
                const child = activeProcesses.get(parsed.serverId);
                if (child && child.stdin) {
                    child.stdin.write(parsed.command + '\n');
                } else {
                    ws.send(JSON.stringify({ type: 'log', data: '[System Error] Server process is not running.' }));
                }
            }
        } catch (e) {
            console.error('Invalid WebSocket message payload:', e);
        }
    });
});

server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` AetherPanel Game Daemon running on port ${PORT}`);
    console.log(` Servers directory: ${SERVERS_DIR}`);
    console.log(` Access dashboard at: http://localhost:${PORT}`);
    console.log(`====================================================`);
});