const button = document.getElementById("create");
const accountsDiv = document.getElementById("accounts");
const totalAccountsEl = document.getElementById("totalAccounts");
const totalCoinsEl = document.getElementById("totalCoins");
const averageLevelEl = document.getElementById("averageLevel");

let accounts = [];
let isRunning = false;

// --- الأكواد السابقة ---
function drawAccounts() {
    accountsDiv.innerHTML = "";
    accounts.forEach(account => {
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = `
            <h2>Account #${account.id}</h2>
            <p>💰 Coins: ${account.coins}</p>
            <p>⭐ Level: ${account.level}</p>
            <p>🟢 Status: ${account.status}</p>
            <p>📋 Task: ${account.task}</p>
        `;
        accountsDiv.appendChild(card);
    });
    updateDashboard();
}

function updateDashboard() {
    const total = accounts.length;
    const coins = accounts.reduce((sum, a) => sum + a.coins, 0);
    const avgLevel = total > 0
        ? (accounts.reduce((sum, a) => sum + a.level, 0) / total).toFixed(1)
        : 0;

    totalAccountsEl.textContent = `📊 Total Accounts: ${total}`;
    totalCoinsEl.textContent = `💰 Total Coins: ${coins}`;
    averageLevelEl.textContent = `📈 Average Level: ${avgLevel}`;
}

// --- النظام الجديد للمهام التفاعلية ---

const TASK_TYPES = [
    { name: "Liking posts",      coins: 5,  xp: 10, duration: 2000 },
    { name: "Following users",   coins: 8,  xp: 15, duration: 3000 },
    { name: "Commenting",        coins: 10, xp: 20, duration: 2500 },
    { name: "Browsing website",  coins: 3,  xp: 5,  duration: 4000 },
    { name: "Sharing content",   coins: 12, xp: 25, duration: 3500 },
    { name: "Watching ads",      coins: 7,  xp: 12, duration: 5000 },
    { name: "Upvoting",          coins: 6,  xp: 10, duration: 2000 },
    { name: "Retweeting",        coins: 9,  xp: 18, duration: 2800 },
];

function getRandomTask() {
    return TASK_TYPES[Math.floor(Math.random() * TASK_TYPES.length)];
}

function assignTask(account) {
    const task = getRandomTask();
    account.coins += task.coins;
    account.level += task.xp;
    account.status = "🔄 Working";
    account.task = task.name;
    account._taskDuration = task.duration;
    account._taskStart = Date.now();
}

function completeTask(account) {
    account.status = "✅ Done";
    // بعد ثانية يرجع Idle وتتسند له مهمة جديدة
    setTimeout(() => {
        if (account.status === "✅ Done") {
            account.status = "🟢 Idle";
            // إذا النظام شغال، أسند مهمة جديدة
            if (isRunning) {
                assignTask(account);
            }
        }
        drawAccounts();
    }, 1000);
}

function processAccounts() {
    const now = Date.now();
    let updated = false;

    accounts.forEach(account => {
        if (account.status === "🔄 Working") {
            if (now - account._taskStart >= account._taskDuration) {
                completeTask(account);
                updated = true;
            }
        } else if (account.status === "🟢 Idle" && isRunning) {
            assignTask(account);
            updated = true;
        }
    });

    if (updated) drawAccounts();
    requestAnimationFrame(processAccounts);
}

// --- تشغيل/إيقاف ---

function startAll() {
    if (accounts.length === 0) {
        alert("Create accounts first!");
        return;
    }
    isRunning = true;
    accounts.forEach(account => {
        if (account.status === "🟢 Idle" || account.status === "✅ Done") {
            assignTask(account);
        }
    });
    drawAccounts();
}

function stopAll() {
    isRunning = false;
    accounts.forEach(account => {
        if (account.status === "🔄 Working") {
            account.status = "⏸️ Paused";
        }
    });
    drawAccounts();
}

function resetAll() {
    isRunning = false;
    accounts.forEach(account => {
        account.coins = 0;
        account.level = 1;
        account.status = "Idle";
        account.task = "None";
    });
    drawAccounts();
}

button.onclick = () => {
    accounts = [];
    for (let i = 1; i <= 1000; i++) {
        accounts.push({
            id: i,
            coins: 0,
            level: 1,
            status: "Idle",
            task: "None"
        });
    }
    drawAccounts();
};

// بداية الحلقة
processAccounts();
updateDashboard();