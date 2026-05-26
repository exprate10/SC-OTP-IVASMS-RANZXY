'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { Telegraf, Markup } = require('telegraf');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const YOUR_BOT_TOKEN = "YOUR_TOKEN_HERE";
const ADMIN_CHAT_IDS = ["123456"];
const INITIAL_CHAT_IDS = ["-100123456"];

const LOGIN_URL = "https://www.ivasms.com/login";
const BASE_URL = "https://www.ivasms.com/";
const SMS_API_ENDPOINT = "https://www.ivasms.com/portal/sms/received/getsms";
const NUMBER_ENDPOINT = "https://www.ivasms.com/portal/sms/received/getsms/number";
const SMS_NUMBER_ENDPOINT = "https://www.ivasms.com/portal/sms/received/getsms/number/sms";
const USERNAME = "email@example.com";
const PASSWORD = "PASSWORD_ANDA";

const STATE_FILE = "processed_sms_ids.json";
const CHAT_IDS_FILE = "chat_ids.json";
const SETTINGS_FILE = "settings.json";
const TEMP_STATE_FILE = "temp_state.json";
const COOKIE_FILE = "ivasms_cookie.json";
const COUNTRY_CACHE_FILE = "country_cache.json";

const COUNTRY_FLAGS = {
    "Unknown Country": "🏴‍☠️",
    "Indonesia": "🇮🇩",
    "Malaysia": "🇲🇾",
    "Singapore": "🇸🇬",
    "Thailand": "🇹🇭",
    "Vietnam": "🇻🇳",
    "Philippines": "🇵🇭",
    "India": "🇮🇳",
    "USA": "🇺🇸",
    "UK": "🇬🇧",
    "Australia": "🇦🇺",
    "Japan": "🇯🇵",
    "Korea": "🇰🇷",
    "China": "🇨🇳",
    "Gambia": "🇬🇲"
};

const SERVICE_EMOJIS = {
    "Unknown": "❓",
    "WhatsApp": "💚",
    "Telegram": "✈️",
    "Google": "🔴",
    "Facebook": "🔵",
    "Instagram": "📸",
    "Twitter": "🐦",
    "TikTok": "🎵",
    "Shopee": "🛍️",
    "Tokopedia": "🛒",
    "Lazada": "📦",
    "Gojek": "🟢",
    "Grab": "🟩",
    "OVO": "💜",
    "Dana": "💙",
    "LinkAja": "❤️"
};

const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let POLLING_INTERVAL_SECONDS = 60;
let pollingTimer = null;
let axiosClient = null;
let currentCookies = null;
let useManualCookie = false;
let isChecking = false;
let retryCount = 0;



function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function detectService(text) {
    const t = text.toLowerCase();
    if (t.includes('whatsapp')) return 'WhatsApp';
    if (t.includes('telegram')) return 'Telegram';
    if (t.includes('google')) return 'Google';
    if (t.includes('facebook') || t.includes(' fb ')) return 'Facebook';
    if (t.includes('instagram') || t.includes(' ig ')) return 'Instagram';
    if (t.includes('twitter')) return 'Twitter';
    if (t.includes('tiktok')) return 'TikTok';
    if (t.includes('shopee')) return 'Shopee';
    if (t.includes('tokopedia')) return 'Tokopedia';
    if (t.includes('lazada')) return 'Lazada';
    if (t.includes('gojek')) return 'Gojek';
    if (t.includes('grab')) return 'Grab';
    if (t.includes('ovo')) return 'OVO';
    if (t.includes('dana')) return 'Dana';
    if (t.includes('linkaja')) return 'LinkAja';
    return 'Unknown';
}

function getCountryFlag(name) {
    if (COUNTRY_FLAGS[name]) return COUNTRY_FLAGS[name];
    for (const [key, flag] of Object.entries(COUNTRY_FLAGS)) {
        if (name.toLowerCase().includes(key.toLowerCase())) return flag;
    }
    return '🏴‍☠️';
}

function createMainMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📊 Status', 'status_bot')],
        [Markup.button.callback('🌍 Live Countries', 'live_countries')],
        [Markup.button.callback('👥 Manage Chats', 'manage_chats')],
        [Markup.button.callback('⚙️ Settings', 'settings_menu')],
        [Markup.button.callback('📨 SMS Log', 'list_sms')],
        [Markup.button.callback('🍪 Get Cookie', 'get_cookie')],
        [Markup.button.callback('🔄 Restart', 'restart_bot'), Markup.button.callback('🗑️ Reset Data', 'delete_all_data')]
    ]);
}

function createBackButton() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back to Main', 'back_to_main')]
    ]);
}



async function loadChatIds() {
    try {
        const data = await fs.readFile(CHAT_IDS_FILE, 'utf8');
        return JSON.parse(data);
    } catch {
        await fs.writeFile(CHAT_IDS_FILE, JSON.stringify(INITIAL_CHAT_IDS, null, 2));
        return [...INITIAL_CHAT_IDS];
    }
}

async function saveChatIds(chatIds) {
    await fs.writeFile(CHAT_IDS_FILE, JSON.stringify(chatIds, null, 2));
}

let _processedCache = null;

async function loadProcessedIds() {
    if (_processedCache) return _processedCache;
    try {
        const data = await fs.readFile(STATE_FILE, 'utf8');
        _processedCache = new Set(JSON.parse(data));
        return _processedCache;
    } catch {
        _processedCache = new Set();
        return _processedCache;
    }
}

async function saveProcessedId(sid) {
    const ids = await loadProcessedIds();
    ids.add(sid);
    await fs.writeFile(STATE_FILE, JSON.stringify([...ids], null, 2));
}

async function loadSettings() {
    try {
        const data = await fs.readFile(SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch {
        const def = { interval: 60, notifications: true, messageFormat: 'detailed' };
        await fs.writeFile(SETTINGS_FILE, JSON.stringify(def, null, 2));
        return def;
    }
}

async function saveSettings(settings) {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

async function loadTempState() {
    try {
        const data = await fs.readFile(TEMP_STATE_FILE, 'utf8');
        return JSON.parse(data);
    } catch {
        return { waitingFor: null, tempData: {} };
    }
}

async function saveTempState(state) {
    await fs.writeFile(TEMP_STATE_FILE, JSON.stringify(state, null, 2));
}

async function saveCookies(cookieString) {
    await fs.writeFile(COOKIE_FILE, JSON.stringify({ cookie: cookieString, timestamp: Date.now() }, null, 2));
    currentCookies = cookieString;
}

async function loadCookies() {
    try {
        const data = await fs.readFile(COOKIE_FILE, 'utf8');
        const parsed = JSON.parse(data);
        currentCookies = parsed.cookie;
        return parsed;
    } catch {
        return null;
    }
}

async function loadCountryCache() {
    try {
        const data = await fs.readFile(COUNTRY_CACHE_FILE, 'utf8');
        const parsed = JSON.parse(data);
        if (Date.now() - parsed.timestamp < 3600000) return parsed.data;
        return null;
    } catch {
        return null;
    }
}

async function saveCountryCache(countryData) {
    await fs.writeFile(COUNTRY_CACHE_FILE, JSON.stringify({ data: countryData, timestamp: Date.now() }, null, 2));
}



function buildHeaders(extra = {}) {
    return {
        'User-Agent': LINUX_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'DNT': '1',
        ...extra
    };
}

async function initAxiosWithCookie() {
    const headers = buildHeaders();
    const saved = await loadCookies();
    if (saved && saved.cookie) {
        headers['Cookie'] = saved.cookie;
        useManualCookie = true;
    } else {
        useManualCookie = false;
    }
    axiosClient = axios.create({ timeout: 45000, maxRedirects: 5, headers });
    return axiosClient;
}

async function refreshCookie() {
    if (useManualCookie) return true;
    try {
        await delay(2000);
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--window-size=1920,1080',
                '--disable-dev-shm-usage',
                '--lang=id-ID,id'
            ]
        });

        const page = await browser.newPage();

        await page.setViewport({ width: 1920, height: 1080 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
        });

        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(2000 + Math.random() * 3000);

        await page.waitForSelector('input[name="email"]', { timeout: 30000 });

        await page.click('input[name="email"]');
        await delay(300 + Math.random() * 500);
        await page.type('input[name="email"]', USERNAME, { delay: 50 + Math.random() * 80 });

        await delay(500 + Math.random() * 1000);

        await page.click('input[name="password"]');
        await delay(300 + Math.random() * 500);
        await page.type('input[name="password"]', PASSWORD, { delay: 50 + Math.random() * 80 });

        await delay(1000 + Math.random() * 2000);

        const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
        if (submitBtn) {
            await submitBtn.click();
        } else {
            await page.evaluate(() => {
                const form = document.querySelector('form');
                if (form) form.submit();
            });
        }

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await delay(3000);

        const cookies = await page.cookies();
        await browser.close();

        if (cookies.length > 0) {
            const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            await saveCookies(cookieString);
            if (axiosClient) axiosClient.defaults.headers['Cookie'] = cookieString;
            return true;
        }

        return false;
    } catch (err) {
        console.error('refreshCookie puppeteer error:', err.message);
        return false;
    }
}

async function ensureValidSession() {
    if (!axiosClient) await initAxiosWithCookie();
    if (!currentCookies && !useManualCookie) {
        await refreshCookie();
        return axiosClient;
    }
    if (currentCookies) {
        try {
            const res = await axiosClient.get(BASE_URL, { timeout: 15000, maxRedirects: 5 });
            const finalUrl = res.request?.res?.responseUrl || res.config?.url || '';
            if (finalUrl.includes('login')) {
                useManualCookie = false;
                currentCookies = null;
                await refreshCookie();
            }
        } catch {
        }
    }
    return axiosClient;
}

async function getCsrfToken() {
    const res = await axiosClient.get(BASE_URL, { timeout: 20000 });
    const $ = cheerio.load(res.data);
    return $('meta[name="csrf-token"]').attr('content') || null;
}

function getDateRange(daysBack = 7) {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - daysBack);
    return {
        fd: start.toLocaleDateString('en-US'),
        td: today.toLocaleDateString('en-US')
    };
}



async function fetchLiveCountries() {
    try {
        await ensureValidSession();
        const { fd, td } = getDateRange(7);
        const csrf = await getCsrfToken();
        if (!csrf) return null;

        const payload = new URLSearchParams({ from: fd, to: td, _token: csrf });
        const res = await axiosClient.post(SMS_API_ENDPOINT, payload.toString(), {
            headers: buildHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE_URL })
        });

        const $ = cheerio.load(res.data);
        const groups = $('div.pointer');
        if (groups.length === 0) return null;

        const countriesMap = new Map();
        const numbersMap = new Map();

        for (let i = 0; i < groups.length; i++) {
            const el = groups[i];
            const onclick = $(el).attr('onclick') || '';
            const match = onclick.match(/getDetials\('([^']+)'\)/);
            if (!match) continue;

            const gid = match[1];
            const rawText = $(el).text().trim().replace(/\d/g, '').trim();
            const countryName = rawText.length > 0 && rawText.length < 50 ? rawText : null;
            if (!countryName) continue;

            const count = countriesMap.get(countryName) || 0;
            countriesMap.set(countryName, count + 1);

            const numPayload = new URLSearchParams({ start: fd, end: td, range: gid, _token: csrf });
            try {
                const numRes = await axiosClient.post(NUMBER_ENDPOINT, numPayload.toString(), {
                    headers: buildHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE_URL })
                });
                const n$ = cheerio.load(numRes.data);
                const numbers = n$("div[onclick*='getDetialsNumber']").map((_, d) => n$(d).text().trim()).get().filter(Boolean);
                if (numbers.length > 0) numbersMap.set(countryName, numbers);
            } catch {
            }
            await delay(400);
        }

        const sorted = Array.from(countriesMap.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([name, traffic]) => ({ name, traffic, numbers: numbersMap.get(name) || [] }));

        const result = {
            allCountries: sorted,
            highTraffic: sorted.slice(0, 8),
            active: sorted.slice(0, 15),
            popular: sorted.slice(0, 20),
            numbersMap: Object.fromEntries(numbersMap),
            lastUpdate: Date.now()
        };

        await saveCountryCache(result);
        return result;
    } catch (err) {
        console.error('fetchLiveCountries error:', err.message);
        return null;
    }
}



async function getNumbersByCountry(countryName) {
    try {
        await ensureValidSession();
        const { fd, td } = getDateRange(7);
        const csrf = await getCsrfToken();
        if (!csrf) return [];

        const payload = new URLSearchParams({ from: fd, to: td, _token: csrf });
        const res = await axiosClient.post(SMS_API_ENDPOINT, payload.toString(), {
            headers: buildHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE_URL })
        });

        const $ = cheerio.load(res.data);
        const groups = $('div.pointer');
        let targetGid = null;

        groups.each((_, el) => {
            if (targetGid) return;
            const text = $(el).text().trim();
            if (text.toLowerCase().includes(countryName.toLowerCase())) {
                const onclick = $(el).attr('onclick') || '';
                const match = onclick.match(/getDetials\('([^']+)'\)/);
                if (match) targetGid = match[1];
            }
        });

        if (!targetGid) return [];

        const numPayload = new URLSearchParams({ start: fd, end: td, range: targetGid, _token: csrf });
        const numRes = await axiosClient.post(NUMBER_ENDPOINT, numPayload.toString(), {
            headers: buildHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE_URL })
        });

        const n$ = cheerio.load(numRes.data);
        return n$("div[onclick*='getDetialsNumber']").map((_, d) => n$(d).text().trim()).get().filter(Boolean);
    } catch (err) {
        console.error('getNumbersByCountry error:', err.message);
        return [];
    }
}



async function fetchSms() {
    try {
        await ensureValidSession();
        const { fd, td } = getDateRange(1);
        const csrf = await getCsrfToken();
        if (!csrf) return [];

        const payload = new URLSearchParams({ from: fd, to: td, _token: csrf });
        const res = await axiosClient.post(SMS_API_ENDPOINT, payload.toString(), {
            headers: buildHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE_URL })
        });

        const $ = cheerio.load(res.data);
        const groups = $('div.pointer');
        if (groups.length === 0) return [];

        const gids = [];
        groups.each((_, el) => {
            const onclick = $(el).attr('onclick') || '';
            const match = onclick.match(/getDetials\('([^']+)'\)/);
            if (match) gids.push({ gid: match[1], countryRaw: $(el).text().trim().replace(/\d/g, '').trim() });
        });

        const allMsgs = [];
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

        for (const { gid, countryRaw } of gids) {
            const countryName = countryRaw || gid;

            const nPayload = new URLSearchParams({ start: fd, end: td, range: gid, _token: csrf });
            let nums = [];
            try {
                const nr = await axiosClient.post(NUMBER_ENDPOINT, nPayload.toString(), {
                    headers: buildHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE_URL })
                });
                const n$ = cheerio.load(nr.data);
                nums = n$("div[onclick*='getDetialsNumber']").map((_, d) => n$(d).text().trim()).get().filter(Boolean);
            } catch {
                continue;
            }

            for (const num of nums) {
                const sPayload = new URLSearchParams({ start: fd, end: td, Number: num, Range: gid, _token: csrf });
                let cards;
                try {
                    const sr = await axiosClient.post(SMS_NUMBER_ENDPOINT, sPayload.toString(), {
                        headers: buildHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE_URL })
                    });
                    const s$ = cheerio.load(sr.data);
                    cards = s$('div.card-body');

                    cards.each((_, card) => {
                        const p = s$(card).find('p.mb-0');
                        if (!p.length) return;

                        const text = p.text().trim();
                        if (!text) return;

                        const codeMatch = text.match(/\b(\d{4,8})\b/);
                        const code = codeMatch ? codeMatch[1] : 'N/A';
                        const service = detectService(text);
                        const flag = getCountryFlag(countryName);
                        const serviceEmoji = SERVICE_EMOJIS[service] || '❓';

                        const sid = `${num}::${Buffer.from(text).toString('base64').substring(0, 40)}`;

                        allMsgs.push({
                            id: sid,
                            time: now,
                            number: num,
                            country: countryName,
                            flag,
                            service,
                            serviceEmoji,
                            code,
                            full_sms: text
                        });
                    });
                } catch {
                    continue;
                }
                await delay(200);
            }
        }

        return allMsgs;
    } catch (err) {
        console.error('fetchSms error:', err.message);
        if (err.response?.status === 401 || err.response?.status === 419) {
            useManualCookie = false;
            currentCookies = null;
            await refreshCookie();
        }
        return [];
    }
}



async function sendMsg(bot, chatId, data, settings) {
    let msg;

    if (settings.messageFormat === 'simple') {
        msg = `<blockquote><b>🔔 OTP MASUK</b>

${data.serviceEmoji} <b>${escapeHtml(data.service)}</b>

📞 <code>${escapeHtml(data.number)}</code>
🔑 <b><code>${escapeHtml(data.code)}</code></b>
🌍 ${data.flag} ${escapeHtml(data.country)}
⏱️ ${escapeHtml(data.time)}</blockquote>`;
    } else {
        msg = `<blockquote><b>🔔 OTP BARU MASUK</b>

${data.serviceEmoji} <b>${escapeHtml(data.service)}</b>

<b>📞 Nomor:</b> <code>${escapeHtml(data.number)}</code>
<b>🔑 Kode OTP:</b> <b><code>${escapeHtml(data.code)}</code></b>
<b>🌍 Negara:</b> ${data.flag} <b>${escapeHtml(data.country)}</b>
<b>⏱️ Waktu:</b> <code>${escapeHtml(data.time)}</code>

<b>💬 Isi SMS:</b>
<code>${escapeHtml(data.full_sms.substring(0, 400))}</code></blockquote>`;
    }

    try {
        await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (err) {
        console.error(`Gagal kirim ke ${chatId}:`, err.message);
    }
}

async function checkSms(bot) {
    if (isChecking) return;
    isChecking = true;
    try {
        const msgs = await fetchSms();
        if (msgs.length === 0) return;

        const processed = await loadProcessedIds();
        const chats = await loadChatIds();
        const settings = await loadSettings();

        for (const m of msgs) {
            if (!processed.has(m.id)) {
                if (settings.notifications && chats.length > 0) {
                    for (const cid of chats) {
                        await sendMsg(bot, cid, m, settings);
                        await delay(100);
                    }
                }
                await saveProcessedId(m.id);
                retryCount = 0;
            }
        }
    } catch (err) {
        console.error('checkSms error:', err.message);
        retryCount++;
        if (retryCount >= 3) {
            useManualCookie = false;
            currentCookies = null;
            await refreshCookie();
            retryCount = 0;
        }
    } finally {
        isChecking = false;
    }
}

function restartPolling(bot) {
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = setInterval(() => checkSms(bot), POLLING_INTERVAL_SECONDS * 1000);
}

async function testIvasmsConnection() {
    const t0 = Date.now();
    try {
        await ensureValidSession();
        const res = await axiosClient.get(BASE_URL, { timeout: 15000, maxRedirects: 5 });
        const finalUrl = res.request?.res?.responseUrl || res.config?.url || '';
        const isLoggedIn = !finalUrl.includes('login');
        return { success: true, responseTime: Date.now() - t0, loginSuccess: isLoggedIn };
    } catch (err) {
        return { success: false, error: err.message, responseTime: Date.now() - t0, loginSuccess: false };
    }
}



function setupCommands(bot) {

    bot.command('start', async (ctx) => {
        try {
            const uid = String(ctx.from.id);
            const isAdmin = ADMIN_CHAT_IDS.includes(uid);
            const msg = `<blockquote><b>🤖 IVASMS BOT</b>

Halo ${isAdmin ? '👑 Admin' : '👤 User'}, bot aktif nih.

<b>Yang bisa dilakuin:</b>
📨 Auto ambil SMS dari IVASMS
🔔 Notif OTP real-time
🌍 Deteksi negara otomatis
🍪 Support manual cookie

Pilih menu di bawah:</blockquote>`;
            await ctx.reply(msg, { parse_mode: 'HTML', ...createMainMenu() });
        } catch (err) {
            console.error('start error:', err);
            await ctx.reply('<blockquote><b>❌ Gagal load menu.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('get_cookie', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply('<blockquote><b>🍪 Lagi login ke IVASMS...</b>\n\nPake browser beneran, tunggu 10-20 detik...</blockquote>', { parse_mode: 'HTML' });

            const browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                    '--window-size=1920,1080',
                    '--disable-dev-shm-usage',
                    '--lang=id-ID,id'
                ]
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
            });

            await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(2000 + Math.random() * 3000);

            const emailField = await page.$('input[name="email"]');
            if (!emailField) {
                await browser.close();
                return ctx.reply('<blockquote><b>❌ Gagal</b>\n\nHalaman login nggak ketemu form email. Mungkin Cloudflare block.</blockquote>', { parse_mode: 'HTML' });
            }

            await page.click('input[name="email"]');
            await delay(300 + Math.random() * 500);
            await page.type('input[name="email"]', USERNAME, { delay: 50 + Math.random() * 80 });

            await delay(500 + Math.random() * 1000);

            await page.click('input[name="password"]');
            await delay(300 + Math.random() * 500);
            await page.type('input[name="password"]', PASSWORD, { delay: 50 + Math.random() * 80 });

            await delay(1000 + Math.random() * 2000);

            const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
            if (submitBtn) {
                await submitBtn.click();
            } else {
                await page.evaluate(() => {
                    const form = document.querySelector('form');
                    if (form) form.submit();
                });
            }

            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await delay(3000);

            const finalUrl = page.url();
            const cookies = await page.cookies();
            await browser.close();

            if (cookies.length > 0 && !finalUrl.includes('login')) {
                const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                await saveCookies(cookieString);
                if (axiosClient) axiosClient.defaults.headers['Cookie'] = cookieString;
                useManualCookie = true;

                await ctx.reply(`<blockquote><b>✅ Login berhasil!</b>

<b>Status:</b> Aktif
<b>Cookie:</b> ${cookies.length} entries
<b>Metode:</b> Headless Browser (anti-detect)

Bot sekarang bisa akses IVASMS tanpa masalah.</blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
            } else {
                await ctx.reply(`<blockquote><b>❌ Login gagal</b>

Browser berhasil buka halaman tapi login nggak berhasil.

<b>Kemungkinan:</b>
• Email/password salah
• Ada captcha tambahan
• Akun diblokir

Cek credentials lo dulu.</blockquote>`, { parse_mode: 'HTML' });
            }
        } catch (err) {
            console.error('get_cookie puppeteer error:', err);
            await ctx.reply(`<blockquote><b>❌ Error</b>\n\n${escapeHtml(err.message)}\n\nPastiin server punya cukup RAM buat jalanin browser.</blockquote>`, { parse_mode: 'HTML' });
        }
    });

    bot.action('live_countries', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply('<blockquote><b>🌍 Lagi ngambil data negara...</b></blockquote>', { parse_mode: 'HTML' });

            const countryData = await fetchLiveCountries();
            if (!countryData || !countryData.highTraffic || countryData.highTraffic.length === 0) {
                return ctx.reply('<blockquote><b>❌ Data kosong atau session expired.</b>\n\nCoba ambil cookie dulu.</blockquote>', { parse_mode: 'HTML', ...createBackButton() });
            }

            const buttons = countryData.highTraffic.map(c => {
                const flag = getCountryFlag(c.name);
                return [Markup.button.callback(`${flag} ${c.name} (${c.traffic} SMS)`, `view_numbers_${c.name}`)];
            });
            buttons.push([Markup.button.callback('🔙 Kembali', 'back_to_main')]);

            const list = countryData.highTraffic.map((c, i) =>
                `${i + 1}. ${getCountryFlag(c.name)} <b>${escapeHtml(c.name)}</b> — <code>${c.traffic} SMS</code>`
            ).join('\n');

            const msg = `<blockquote><b>🌍 Live Countries — Traffic Tertinggi</b>

${list}

Klik negara buat lihat nomornya:</blockquote>`;
            await ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        } catch (err) {
            console.error('live_countries error:', err);
            await ctx.reply('<blockquote><b>❌ Error ambil data negara.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action(/^view_numbers_(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }

            const countryName = ctx.match[1];
            const flag = getCountryFlag(countryName);

            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(`<blockquote><b>📞 Ngambil nomor untuk ${flag} ${escapeHtml(countryName)}...</b></blockquote>`, { parse_mode: 'HTML' });

            const numbers = await getNumbersByCountry(countryName);
            if (!numbers || numbers.length === 0) {
                return ctx.reply('<blockquote><b>❌ Nomor nggak ditemukan.</b></blockquote>', { parse_mode: 'HTML', ...createBackButton() });
            }

            const numbersList = numbers.map((num, i) => `${i + 1}. <code>${escapeHtml(num)}</code>`).join('\n');
            const msg = `<blockquote><b>📞 Nomor Tersedia</b>
${flag} <b>${escapeHtml(countryName)}</b>

<b>Total:</b> <code>${numbers.length} nomor</code>

${numbersList}</blockquote>`;

            const numberButtons = numbers.slice(0, 10).map(num =>
                [Markup.button.callback(`📱 ${num}`, `vsms_${encodeURIComponent(countryName)}_${encodeURIComponent(num)}`)]
            );
            numberButtons.push([Markup.button.callback('🔙 Kembali ke Negara', 'live_countries')]);
            numberButtons.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

            await ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(numberButtons) });
        } catch (err) {
            console.error('view_numbers error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action(/^vsms_(.+)_(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }

            const countryName = decodeURIComponent(ctx.match[1]);
            const number = decodeURIComponent(ctx.match[2]);
            const flag = getCountryFlag(countryName);

            const processedIds = await loadProcessedIds();
            const related = [...processedIds].filter(id => id.startsWith(`${number}::`)).slice(-10);

            if (related.length === 0) {
                return ctx.reply(`<blockquote><b>📭 Belum ada riwayat SMS</b>
${flag} ${escapeHtml(countryName)}
📞 <code>${escapeHtml(number)}</code></blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
            }

            const smsList = related.map((s, i) => `${i + 1}. <code>${escapeHtml(s.substring(0, 60))}...</code>`).join('\n');
            const msg = `<blockquote><b>📨 Riwayat OTP</b>
${flag} <b>${escapeHtml(countryName)}</b>
📞 <code>${escapeHtml(number)}</code>

<b>Total:</b> <code>${related.length} SMS</code>

${smsList}</blockquote>`;
            await ctx.reply(msg, { parse_mode: 'HTML', ...createBackButton() });
        } catch (err) {
            console.error('vsms error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('status_bot', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.deleteMessage().catch(() => {});

            const chatIds = await loadChatIds();
            const processedIds = await loadProcessedIds();
            const settings = await loadSettings();
            const uptime = Math.floor(process.uptime() / 60);
            const memory = Math.round(process.memoryUsage().rss / 1024 / 1024);
            const sessionStatus = useManualCookie ? '🟢 Manual Cookie' : (currentCookies ? '🟢 Auto Login' : '🟡 Belum login');

            const msg = `<blockquote><b>📊 Status Sistem</b>

<b>🟢 Bot:</b> <code>Running</code>
<b>👥 Chat aktif:</b> <code>${chatIds.length}</code>
<b>📨 Total SMS:</b> <code>${processedIds.size}</code>
<b>⏰ Interval:</b> <code>${settings.interval}s</code>
<b>🔔 Notif:</b> <code>${settings.notifications ? 'ON' : 'OFF'}</code>
<b>🔐 Session:</b> <code>${sessionStatus}</code>

<b>🖥️ Server:</b>
<b>Platform:</b> <code>${process.platform}</code>
<b>Uptime:</b> <code>${uptime} menit</code>
<b>Memory:</b> <code>${memory} MB</code>

✅ Semua sistem jalan normal</blockquote>`;
            await ctx.reply(msg, { parse_mode: 'HTML', ...createBackButton() });
        } catch (err) {
            console.error('status_bot error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });



    bot.action('manage_chats', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply('<blockquote><b>👥 Manage Chats</b></blockquote>', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('➕ Tambah Chat', 'add_chat_menu')],
                    [Markup.button.callback('➖ Hapus Chat', 'remove_chat_menu')],
                    [Markup.button.callback('📋 List Chat', 'list_chats_menu')],
                    [Markup.button.callback('🧹 Clear Semua', 'clear_chats_menu')],
                    [Markup.button.callback('🔙 Kembali', 'back_to_main')]
                ])
            });
        } catch (err) {
            console.error('manage_chats error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('add_chat_menu', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.reply(`<blockquote><b>➕ Tambah Chat ID</b>

Kirim Chat ID yang mau ditambahin.

<b>Contoh:</b>
📁 Grup: <code>-100123456789</code>
👤 Private: <code>123456789</code>

Ketik /batal buat cancel.</blockquote>`, { parse_mode: 'HTML' });
            await saveTempState({ waitingFor: 'add_chat', tempData: {} });
        } catch (err) {
            console.error('add_chat_menu error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('remove_chat_menu', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            const chatIds = await loadChatIds();
            if (chatIds.length === 0) {
                return ctx.reply('<blockquote><b>📭 Belum ada chat terdaftar.</b></blockquote>', { parse_mode: 'HTML', ...createBackButton() });
            }
            const buttons = chatIds.map(id => [Markup.button.callback(`❌ ${id}`, `rm_chat_${id}`)]);
            buttons.push([Markup.button.callback('🔙 Kembali', 'back_to_main')]);
            await ctx.reply(`<blockquote><b>➖ Hapus Chat</b>

Pilih chat yang mau dihapus:
<b>Total:</b> <code>${chatIds.length} chat</code></blockquote>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        } catch (err) {
            console.error('remove_chat_menu error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action(/^rm_chat_(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            const targetId = ctx.match[1];
            const chatIds = await loadChatIds();
            const idx = chatIds.indexOf(targetId);
            if (idx > -1) {
                chatIds.splice(idx, 1);
                await saveChatIds(chatIds);
                await ctx.reply(`<blockquote><b>✅ Berhasil</b>\n\nChat ID <code>${escapeHtml(targetId)}</code> sudah dihapus.</blockquote>`, { parse_mode: 'HTML' });
            } else {
                await ctx.reply(`<blockquote><b>❌ Gagal</b>\n\nChat ID <code>${escapeHtml(targetId)}</code> nggak ditemukan.</blockquote>`, { parse_mode: 'HTML' });
            }
        } catch (err) {
            console.error('rm_chat error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('list_chats_menu', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            const chatIds = await loadChatIds();
            if (chatIds.length === 0) {
                return ctx.reply('<blockquote><b>📭 Belum ada chat terdaftar.</b></blockquote>', { parse_mode: 'HTML', ...createBackButton() });
            }
            const list = chatIds.map((id, i) => `${i + 1}. <code>${escapeHtml(id)}</code>`).join('\n');
            await ctx.reply(`<blockquote><b>👥 Daftar Chat</b>

${list}

<b>Total:</b> <code>${chatIds.length} chat</code></blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
        } catch (err) {
            console.error('list_chats_menu error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('clear_chats_menu', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.reply(`<blockquote><b>🧹 Hapus Semua Chat</b>

⚠️ Ini bakal hapus semua chat terdaftar.

<b>Nggak bisa di-undo.</b>

Yakin?</blockquote>`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Ya, hapus semua', 'confirm_clear_chats')],
                    [Markup.button.callback('❌ Batal', 'back_to_main')]
                ])
            });
        } catch (err) {
            console.error('clear_chats_menu error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('confirm_clear_chats', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await saveChatIds([]);
            await ctx.reply('<blockquote><b>✅ Semua chat sudah dihapus.</b></blockquote>', { parse_mode: 'HTML', ...createBackButton() });
        } catch (err) {
            console.error('confirm_clear_chats error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });



    bot.action('settings_menu', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.deleteMessage().catch(() => {});
            const settings = await loadSettings();
            const notifStatus = settings.notifications ? '🟢 Aktif' : '🔴 Mati';
            const fmtStatus = settings.messageFormat === 'detailed' ? '📝 Detail' : '📄 Simple';
            const authMode = useManualCookie ? 'Manual Cookie' : 'Auto Login';

            await ctx.reply(`<blockquote><b>⚙️ Settings</b>

<b>⏰ Interval:</b> <code>${settings.interval} detik</code>
<b>🔔 Notifikasi:</b> <code>${notifStatus}</code>
<b>📱 Format pesan:</b> <code>${fmtStatus}</code>
<b>🔐 Auth:</b> <code>${authMode}</code></blockquote>`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⏰ Ganti Interval', 'change_interval')],
                    [Markup.button.callback('🔔 Toggle Notif', 'toggle_notifications')],
                    [Markup.button.callback('📱 Ganti Format', 'change_message_format')],
                    [Markup.button.callback('🔧 Test Koneksi', 'test_connection')],
                    [Markup.button.callback('🔙 Kembali', 'back_to_main')]
                ])
            });
        } catch (err) {
            console.error('settings_menu error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('change_interval', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.reply(`<blockquote><b>⏰ Ganti Interval Polling</b>

Kirim angka intervalnya dalam detik.

<b>Range:</b> <code>5 — 300 detik</code>

Contoh: <code>30</code>

Ketik /batal buat cancel.</blockquote>`, { parse_mode: 'HTML' });
            await saveTempState({ waitingFor: 'change_interval', tempData: {} });
        } catch (err) {
            console.error('change_interval error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('toggle_notifications', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            const settings = await loadSettings();
            settings.notifications = !settings.notifications;
            await saveSettings(settings);
            const status = settings.notifications ? 'dinyalain' : 'dimatiin';
            await ctx.reply(`<blockquote><b>🔔 Notifikasi</b>\n\nNotifikasi sekarang <b>${status}</b>.</blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
        } catch (err) {
            console.error('toggle_notifications error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('change_message_format', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            const settings = await loadSettings();
            settings.messageFormat = settings.messageFormat === 'detailed' ? 'simple' : 'detailed';
            await saveSettings(settings);
            const fmt = settings.messageFormat === 'detailed' ? 'Detail' : 'Simple';
            await ctx.reply(`<blockquote><b>📱 Format Pesan</b>\n\nFormat diganti ke: <b>${fmt}</b>.</blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
        } catch (err) {
            console.error('change_message_format error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('test_connection', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.reply('<blockquote><b>🔧 Testing koneksi ke IVASMS...</b></blockquote>', { parse_mode: 'HTML' });
            const result = await testIvasmsConnection();
            if (result.success && result.loginSuccess) {
                await ctx.reply(`<blockquote><b>✅ Koneksi OK</b>

<b>📡 Status:</b> Terhubung
<b>⏱️ Response:</b> <code>${result.responseTime}ms</code>
<b>🔐 Auth:</b> <code>${useManualCookie ? 'Manual Cookie' : 'Auto Login'}</code></blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
            } else {
                await ctx.reply(`<blockquote><b>❌ Koneksi Gagal</b>

<b>Error:</b> ${escapeHtml(result.error || 'Cookie mungkin expired')}

Coba ambil cookie lagi lewat menu 🍪 Get Cookie.</blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
            }
        } catch (err) {
            console.error('test_connection error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('list_sms', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.deleteMessage().catch(() => {});
            const processedIds = await loadProcessedIds();
            const recent = [...processedIds].slice(-10);
            if (recent.length === 0) {
                return ctx.reply('<blockquote><b>📭 Belum ada SMS yang diproses.</b></blockquote>', { parse_mode: 'HTML', ...createBackButton() });
            }
            const list = recent.map((s, i) => `${i + 1}. <code>${escapeHtml(s.substring(0, 55))}...</code>`).join('\n');
            await ctx.reply(`<blockquote><b>📨 Riwayat SMS (10 terakhir)</b>

${list}

<b>Total:</b> <code>${processedIds.size} SMS</code></blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
        } catch (err) {
            console.error('list_sms error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('restart_bot', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.reply('<blockquote><b>🔄 Restart</b>\n\nBot bakal restart dalam 3 detik...</blockquote>', { parse_mode: 'HTML' });
            setTimeout(() => process.exit(0), 3000);
        } catch (err) {
            console.error('restart_bot error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('delete_all_data', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await ctx.reply(`<blockquote><b>🗑️ Reset Data</b>

⚠️ Ini bakal hapus semua:
• Semua Chat ID
• Seluruh riwayat SMS

<b>Nggak bisa di-undo. Yakin?</b></blockquote>`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Ya, hapus semua', 'confirm_delete_all')],
                    [Markup.button.callback('❌ Batal', 'cancel_delete')]
                ])
            });
        } catch (err) {
            console.error('delete_all_data error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('confirm_delete_all', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const uid = String(ctx.from.id);
            if (!ADMIN_CHAT_IDS.includes(uid)) {
                return ctx.reply('<blockquote><b>⛔ Akses ditolak.</b></blockquote>', { parse_mode: 'HTML' });
            }
            await saveChatIds([]);
            await fs.writeFile(STATE_FILE, JSON.stringify([], null, 2));
            _processedCache = new Set();
            await ctx.reply('<blockquote><b>✅ Semua data sudah dihapus.</b></blockquote>', { parse_mode: 'HTML', ...createBackButton() });
        } catch (err) {
            console.error('confirm_delete_all error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.action('cancel_delete', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            await ctx.reply('<blockquote><b>❌ Dibatalin.</b></blockquote>', { parse_mode: 'HTML', ...createBackButton() });
        } catch (err) {
            console.error('cancel_delete error:', err);
        }
    });

    bot.action('back_to_main', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            await ctx.deleteMessage().catch(() => {});
            const uid = String(ctx.from.id);
            const isAdmin = ADMIN_CHAT_IDS.includes(uid);
            const msg = `<blockquote><b>🏠 Main Menu</b>

Balik lagi ${isAdmin ? '👑 Admin' : '👤 User'}.

Mau ngapain?</blockquote>`;
            await ctx.reply(msg, { parse_mode: 'HTML', ...createMainMenu() });
        } catch (err) {
            console.error('back_to_main error:', err);
            await ctx.reply('<blockquote><b>❌ Error.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

    bot.command('batal', async (ctx) => {
        try {
            await saveTempState({ waitingFor: null, tempData: {} });
            await ctx.reply('<blockquote><b>❌ Dibatalin.</b></blockquote>', { parse_mode: 'HTML', ...createMainMenu() });
        } catch (err) {
            console.error('batal error:', err);
        }
    });

    bot.on('text', async (ctx) => {
        try {
            const tempState = await loadTempState();
            const input = ctx.message.text.trim();

            if (input === '/batal') {
                await saveTempState({ waitingFor: null, tempData: {} });
                return ctx.reply('<blockquote><b>❌ Dibatalin.</b></blockquote>', { parse_mode: 'HTML', ...createMainMenu() });
            }

            if (tempState.waitingFor === 'add_chat') {
                const chatIds = await loadChatIds();
                if (!chatIds.includes(input)) {
                    chatIds.push(input);
                    await saveChatIds(chatIds);
                    await ctx.reply(`<blockquote><b>✅ Berhasil</b>\n\nChat ID <code>${escapeHtml(input)}</code> udah ditambah.</blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
                } else {
                    await ctx.reply(`<blockquote><b>⚠️ Chat ID <code>${escapeHtml(input)}</code> udah ada.</b></blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
                }
                await saveTempState({ waitingFor: null, tempData: {} });

            } else if (tempState.waitingFor === 'change_interval') {
                const val = parseInt(input, 10);
                if (isNaN(val) || val < 5 || val > 300) {
                    return ctx.reply('<blockquote><b>❌ Angkanya harus antara 5 sampai 300 detik.</b></blockquote>', { parse_mode: 'HTML' });
                }
                const settings = await loadSettings();
                settings.interval = val;
                await saveSettings(settings);
                POLLING_INTERVAL_SECONDS = val;
                await ctx.reply(`<blockquote><b>✅ Interval diganti ke <code>${val} detik</code>.</b></blockquote>`, { parse_mode: 'HTML', ...createBackButton() });
                await saveTempState({ waitingFor: null, tempData: {} });
            }
        } catch (err) {
            console.error('text handler error:', err);
            await ctx.reply('<blockquote><b>❌ Error waktu proses input.</b></blockquote>', { parse_mode: 'HTML' });
        }
    });

}



async function main() {
    if (YOUR_BOT_TOKEN === 'YOUR_TOKEN_HERE') {
        console.error('ERROR: Ganti YOUR_BOT_TOKEN dulu di konfigurasi!');
        process.exit(1);
    }

    const bot = new Telegraf(YOUR_BOT_TOKEN);

    const settings = await loadSettings();
    POLLING_INTERVAL_SECONDS = settings.interval;

    await initAxiosWithCookie();

    const savedCookie = await loadCookies();
    if (savedCookie && savedCookie.cookie) {
        useManualCookie = true;
        console.log('✅ Cookie tersimpan ditemukan, langsung dipakai.');
    } else {
        console.log('⚠️  Belum ada cookie. Klik 🍪 Get Cookie di menu bot.');
    }

    setupCommands(bot);

    await bot.launch();

    console.log('\n✅ Bot aktif!');
    console.log(`📡 Interval polling: ${POLLING_INTERVAL_SECONDS} detik`);
    console.log(`👥 Admin IDs: ${ADMIN_CHAT_IDS.join(', ')}`);
    console.log(`🔐 Mode auth: ${useManualCookie ? 'Manual Cookie' : 'Menunggu cookie'}\n`);

    setTimeout(() => checkSms(bot), 5000);
    restartPolling(bot);

    process.once('SIGINT', () => {
        if (pollingTimer) clearInterval(pollingTimer);
        bot.stop('SIGINT');
        process.exit(0);
    });

    process.once('SIGTERM', () => {
        if (pollingTimer) clearInterval(pollingTimer);
        bot.stop('SIGTERM');
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
