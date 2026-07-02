const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SERVER_URL = 'http://YOUR_SERVER_IP:3000'; // ⚠️ غير للسيرفر بتاعك

const ACCOUNT = { username: 'user1', password: 'pass1' };
const PROXY = 'http://proxy1:8080';

async function report(status, message) {
    await fetch(`${SERVER_URL}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ACCOUNT.username, status, message })
    });
}

async function register() {
    await fetch(`${SERVER_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ACCOUNT.username, proxy: PROXY })
    });
}

async function getTask() {
    const res = await fetch(`${SERVER_URL}/task?username=${ACCOUNT.username}`);
    return res.json();
}

async function executeTask(task) {
    if (!task || task.type === 'idle') return;

    console.log(`🚀 ${ACCOUNT.username} — Starting ${task.type} on ${task.url}`);
    await report('working', `Starting ${task.type}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [`--proxy-server=${PROXY}`, '--no-sandbox']
    });

    try {
        const page = await browser.newPage();

        // تسجيل دخول
        await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForTimeout(2000);
        await page.type('input[name="username"]', ACCOUNT.username, { delay: 50 });
        await page.type('input[name="password"]', ACCOUNT.password, { delay: 50 });
        await page.click('button[type="submit"]');
        await page.waitForTimeout(4000);

        // الذهاب للتارجت
        await page.goto(task.url, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForTimeout(2000);

        // تنفيذ المهمة
        if (task.type === 'like') {
            const likeBtn = await page.$('span[aria-label="Like"], svg[aria-label="Like"]');
            if (likeBtn) await likeBtn.click();
            await report('done', 'Liked successfully');
        }
        else if (task.type === 'follow') {
            const followBtn = await page.$('button:has(div:contains("Follow"))');
            if (followBtn) await followBtn.click();
            await report('done', 'Followed successfully');
        }
        else if (task.type === 'comment' && task.comment) {
            const input = await page.$('textarea');
            if (input) {
                await input.click();
                await input.type(task.comment, { delay: 30 });
                await page.keyboard.press('Enter');
            }
            await report('done', `Commented: ${task.comment}`);
        }

    } catch (err) {
        await report('failed', err.message);
    } finally {
        await browser.close();
    }
}

// الحلقة الرئيسية
(async () => {
    await register();
    console.log(`✅ ${ACCOUNT.username} — Registered`);

    while (true) {
        const task = await getTask();
        if (task.type !== 'idle' && task.type) {
            await executeTask(task);
        }
        await new Promise(r => setTimeout(r, 5000)); // افحص كل 5 ثواني
    }
})();