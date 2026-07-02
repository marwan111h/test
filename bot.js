const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// ====== CONFIG ======
const C2_URL = process.env.C2_URL || 'ws://YOUR_SERVER_IP:3000/ws';
const BOT_ID = process.env.BOT_ID || 'bot_' + Math.random().toString(36).substr(2, 6);
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'default_pass';
const PROXY = process.env.PROXY || null;
const USER_DATA_DIR = `./profiles/${BOT_ID}`;

// ====== COOKIE HELPERS ======
function getCookiePath(url) {
    const dir = `${USER_DATA_DIR}/cookies`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
        const hostname = new URL(url).hostname;
        return `${dir}/${hostname}.json`;
    } catch { return `${dir}/unknown.json`; }
}

async function saveCookies(page, url) {
    try {
        const cookies = await page.cookies();
        fs.writeFileSync(getCookiePath(url), JSON.stringify(cookies, null, 2));
    } catch (e) { /* ignore */ }
}

async function loadCookies(page, url) {
    try {
        const cookiePath = getCookiePath(url);
        if (fs.existsSync(cookiePath)) {
            const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
            await page.setCookie(...cookies);
            return true;
        }
    } catch (e) { /* ignore */ }
    return false;
}

// ====== ACTION EXECUTOR ======
async function executeActions(page, actions) {
    const results = [];

    for (const [index, action] of actions.entries()) {
        try {
            console.log(`  📍 Step ${index + 1}: ${action.type}`);

            switch (action.type) {

                case 'goto': {
                    const url = action.url || action.value;
                    await page.goto(url, {
                        waitUntil: action.waitUntil || 'networkidle2',
                        timeout: (action.timeout || 60) * 1000
                    });
                    await saveCookies(page, url);
                    results.push({ step: index, status: 'ok', action: action.type });
                    break;
                }

                case 'wait': {
                    const seconds = parseFloat(action.value) || 2;
                    await page.waitForTimeout(seconds * 1000);
                    results.push({ step: index, status: 'ok', action: action.type });
                    break;
                }

                case 'waitForSelector': {
                    await page.waitForSelector(action.selector, { timeout: (action.timeout || 15) * 1000 });
                    results.push({ step: index, status: 'ok', action: action.type });
                    break;
                }

                case 'click': {
                    await page.waitForSelector(action.selector, { timeout: 15000 });
                    if (action.clickCount) {
                        await page.click(action.selector, { clickCount: action.clickCount });
                    } else {
                        await page.click(action.selector);
                    }
                    if (action.waitAfter) await page.waitForTimeout(action.waitAfter * 1000);
                    results.push({ step: index, status: 'ok', action: action.type });
                    break;
                }

                case 'type': {
                    await page.waitForSelector(action.selector, { timeout: 15000 });
                    await page.click(action.selector);
                    if (action.clearFirst) {
                        await page.evaluate(sel => { document.querySelector(sel).value = ''; }, action.selector);
                    }
                    await page.type(action.selector, action.value, { delay: action.delay || 50 + Math.random() * 50 });
                    results.push({ step: index, status: 'ok', action: action.type });
                    break;
                }

                case 'select': {
                    await page.select(action.selector, action.value);
                    results.push({ step: index, status: 'ok', action: action.type });
                    break;
                }

                case 'scroll': {
                    const x = action.x || 0;
                    const y = action.y || 500;
                    await page.evaluate(({ x, y }) => window.scrollBy(x, y), { x, y });
                    await page.waitForTimeout(500 + Math.random() * 1500);
                    results.push({ step: index, status: 'ok', action: action.type });
                    break;
                }

                case 'screenshot': {
                    const filePath = action.filePath || `screenshots/${BOT_ID}_${Date.now()}.png`;
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    await page.screenshot({ path: filePath, fullPage: action.fullPage || false });
                    results.push({ step: index, status: 'ok', action: action.type, file: filePath });
                    break;
                }

                case 'extract': {
                    const text = await page.$eval(action.selector, el => el.textContent.trim());
                    results.push({ step: index, status: 'ok', action: action.type, value: text });
                    break;
                }

                case 'evaluate': {
                    const evalResult = await page.evaluate(action.code);
                    results.push({ step: index, status: 'ok', action: action.type, result: evalResult });
                    break;
                }

                case 'login': {
                    const loginUrl = action.loginUrl || action.url;
                    const loaded = await loadCookies(page, loginUrl);

                    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

                    if (loaded && action.verifyUrl) {
                        await page.goto(action.verifyUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                        await page.waitForTimeout(2000);
                        const currentUrl = page.url();
                        if (currentUrl.includes('login') || currentUrl.includes('auth')) {
                            console.log('  ⚠️ Cookies expired, re-logging in');
                        } else {
                            results.push({ step: index, status: 'ok', action: 'login_using_cookies' });
                            break;
                        }
                    }

                    await page.waitForSelector(action.usernameSelector, { timeout: 15000 });
                    await page.type(action.usernameSelector, action.username, { delay: 50 + Math.random() * 50 });
                    await page.type(action.passwordSelector, action.password, { delay: 50 + Math.random() * 50 });

                    if (action.submitSelector) {
                        await page.click(action.submitSelector);
                    } else {
                        await page.keyboard.press('Enter');
                    }
                    await page.waitForTimeout(3000 + Math.random() * 2000);
                    await saveCookies(page, loginUrl);
                    results.push({ step: index, status: 'ok', action: 'login_success' });
                    break;
                }

                case 'inject': {
                    if (action.code) await page.evaluate(action.code);
                    if (action.scriptUrl) await page.addScriptTag({ url: action.scriptUrl });
                    results.push({ step: index, status: 'ok', action: action.type });
                    break;
                }

                // ====== FOLLOW PRESET ======
                case 'follow': {
                    const profileUrl = action.url;
                    const selector = action.selector || 'button:contains("Follow"), [data-testid*="follow"], .follow-button';

                    console.log(`  ➡️ Following: ${profileUrl}`);
                    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                    await page.waitForTimeout(2000 + Math.random() * 2000);

                    try {
                        await page.waitForSelector(selector, { timeout: 8000 });
                        const btnText = await page.$eval(selector, el => el.textContent.trim().toLowerCase());
                        
                        if (btnText.includes('follow') && !btnText.includes('ing')) {
                            await page.click(selector);
                            await page.waitForTimeout(1000 + Math.random() * 2000);
                            console.log(`  ✅ Followed: ${profileUrl}`);
                            results.push({ step: index, status: 'ok', action: 'follow', url: profileUrl });
                        } else {
                            console.log(`  ⏭️ Already following: ${profileUrl}`);
                            results.push({ step: index, status: 'skipped', action: 'follow', reason: 'already_following', url: profileUrl });
                        }
                    } catch (err) {
                        console.log(`  ❌ Button not found: ${profileUrl}`);
                        results.push({ step: index, status: 'error', action: 'follow', error: 'button_not_found', url: profileUrl });
                    }
                    break;
                }

                // ====== MASS FOLLOW ======
                case 'massFollow': {
                    const urls = action.urls || [action.url];
                    const followSelector = action.selector || 'button:contains("Follow"), [data-testid*="follow"]';
                    const delayBetween = action.delay || 5000 + Math.random() * 10000;
                    const followResults = [];

                    for (const url of urls) {
                        try {
                            console.log(`  ➡️ [${followResults.length + 1}/${urls.length}] Following: ${url}`);
                            await page.goto(url.trim(), { waitUntil: 'networkidle2', timeout: 60000 });
                            await page.waitForTimeout(2000 + Math.random() * 2000);

                            try {
                                await page.waitForSelector(followSelector, { timeout: 8000 });
                                const btnText = await page.$eval(followSelector, el => el.textContent.trim().toLowerCase());
                                if (btnText.includes('follow') && !btnText.includes('ing')) {
                                    await page.click(followSelector);
                                    await page.waitForTimeout(1000 + Math.random() * 2000);
                                    followResults.push({ url, status: 'followed' });
                                    console.log(`  ✅ Followed`);
                                } else {
                                    followResults.push({ url, status: 'already_following' });
                                    console.log(`  ⏭️ Already following`);
                                }
                            } catch (err) {
                                followResults.push({ url, status: 'button_not_found' });
                                console.log(`  ❌ Button not found`);
                            }

                            // Random delay بين كل فولو
                            await page.waitForTimeout(delayBetween);
                        } catch (err) {
                            followResults.push({ url, status: 'error', error: err.message });
                        }
                    }

                    const followed = followResults.filter(r => r.status === 'followed').length;
                    results.push({ step: index, status: 'ok', action: 'massFollow', total: urls.length, followed, results: followResults });
                    break;
                }

                default: {
                    results.push({ step: index, status: 'unknown', action: action.type });
                    console.log(`  ⚠️ Unknown action: ${action.type}`);
                }
            }
        } catch (err) {
            console.error(`  ❌ Step ${index + 1} failed:`, err.message);
            results.push({ step: index, status: 'error', error: err.message });

            if (!action.optional) {
                throw { step: index, message: err.message, results };
            }
        }
    }

    return results;
}

// ====== MAIN BOT LOOP ======
let ws = null;
let browser = null;
let reconnectTimer = null;

function connect() {
    if (ws) ws.terminate();

    ws = new WebSocket(C2_URL);

    ws.on('open', () => {
        console.log(`✅ Connected to C2`);
        ws.send(JSON.stringify({ type: 'auth', id: BOT_ID, password: BOT_PASSWORD }));
    });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'auth_ok': {
                    console.log(`🔐 Authenticated as ${msg.id}`);
                    break;
                }
                case 'idle': {
                    console.log(`💤 No tasks`);
                    break;
                }
                case 'task': {
                    await runTask(msg);
                    break;
                }
                case 'stop': {
                    console.log(`🛑 Stop command`);
                    if (browser) { await browser.close(); browser = null; }
                    break;
                }
                case 'pong': break;
            }
        } catch (err) {
            console.error('Error handling message:', err);
        }
    });

    ws.on('close', () => {
        console.log('❌ Disconnected from C2');
        ws = null;
        const delay = 3000 + Math.random() * 7000;
        reconnectTimer = setTimeout(connect, delay);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        ws.close();
    });
}

async function runTask(task) {
    console.log(`🚀 Running task ${task.id} | ${task.actions.length} steps`);

    try {
        report('working', `Starting task ${task.id}`, task.id);

        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--disable-gpu',
                '--window-size=1366,768',
                '--disable-blink-features=AutomationControlled',
                ...(PROXY ? [`--proxy-server=${PROXY}`] : [])
            ],
            userDataDir: USER_DATA_DIR
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });

        // تجنب كشف الأتمتة
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });

        const results = await executeActions(page, task.actions);

        const successCount = results.filter(r => r.status === 'ok').length;
        const errorCount = results.filter(r => r.status === 'error').length;

        await report('done', `Task ${task.id}: ${successCount} OK, ${errorCount} errors`, task.id, { results });

    } catch (err) {
        console.error(`❌ Task ${task.id} failed:`, err.message);
        await report('failed', `Task ${task.id}: ${err.message}`, task.id, { error: err.message });
    } finally {
        if (browser) { await browser.close(); browser = null; }
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ready' }));
        }
    }
}

function report(status, message, taskId, extra = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'report', status, message, taskId, ...extra, time: Date.now() }));
    }
}

// Heartbeat
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
    }
}, 30000);

// ====== START ======
console.log(`🤖 Bot: ${BOT_ID} | Proxy: ${PROXY || 'None'}`);
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
if (!fs.existsSync('screenshots')) fs.mkdirSync('screenshots');
connect();