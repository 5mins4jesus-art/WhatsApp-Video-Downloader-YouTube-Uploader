#!/usr/bin/env node
/**
 * List WhatsApp chat history using baileys (the same library/session mudslide
 * uses). Unlike whatsapp-web.js, baileys can request older history segments
 * from the phone via `fetchMessageHistory` and receive them through
 * `messaging-history.set` events. This is the only path that can recover
 * messages older than the linked-device pairing time.
 *
 * Usage:
 *   node list_historic_messages_baileys.mjs <jid-or-group-name> [limit] \
 *        [--today | --day-offset N | --last-days N] [--debug]
 *
 * Notes:
 * - Uses the mudslide auth folder (~/.local/share/mudslide) so it shares the
 *   already-paired session. Do not run this concurrently with mudslide or any
 *   other baileys client using the same creds — WhatsApp will 401 one of them.
 * - History sync from the phone is best-effort. WhatsApp may rate-limit or
 *   refuse to send arbitrarily old messages; the script repeatedly walks
 *   backwards from the oldest known message until no further history arrives.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestWaWebVersion,
    DisconnectReason,
} from 'baileys';
import P from 'pino';

const AUTH_FOLDER = process.env.WA_AUTH_FOLDER
    || path.join(os.homedir(), '.local', 'share', 'mudslide');
const EASTERN_TIME_ZONE = 'America/New_York';

const args = process.argv.slice(2);
const TARGET = args[0];
const LIMIT = Number.parseInt(args[1] || '200', 10);
const TODAY = args.includes('--today');
const DEBUG = args.includes('--debug');
const DAY_OFFSET_INDEX = args.indexOf('--day-offset');
const DAY_OFFSET = DAY_OFFSET_INDEX !== -1 ? Number.parseInt(args[DAY_OFFSET_INDEX + 1] || '0', 10) : null;
const LAST_DAYS_INDEX = args.indexOf('--last-days');
const LAST_DAYS = LAST_DAYS_INDEX !== -1 ? Number.parseInt(args[LAST_DAYS_INDEX + 1] || '1', 10) : null;

// Sync tuning.
const INITIAL_SYNC_WAIT_MS = 8000;     // wait for the initial history dump
const HISTORY_BATCH_SIZE = 50;
const HISTORY_WAIT_MS = 4500;          // time per fetchMessageHistory round
const MAX_HISTORY_ROUNDS = 40;         // hard cap on backwards pagination

function printUsage() {
    console.log('Usage: node list_historic_messages_baileys.mjs <jid-or-group-name> [limit] [--today | --day-offset N | --last-days N] [--debug]');
}

if (!TARGET || TARGET === '-h' || TARGET === '--help') {
    printUsage();
    process.exit(1);
}
if ([TODAY, DAY_OFFSET !== null, LAST_DAYS !== null].filter(Boolean).length > 1) {
    console.error('[ERROR] Use only one of --today, --day-offset, --last-days.');
    process.exit(1);
}
if (LAST_DAYS !== null && (!Number.isInteger(LAST_DAYS) || LAST_DAYS <= 0)) {
    console.error('[ERROR] --last-days requires a positive integer.');
    process.exit(1);
}

function debug(...parts) {
    if (DEBUG) console.error('[DEBUG]', ...parts);
}

function normalizeSearchString(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getTimestampSeconds(value) {
    if (value && typeof value === 'object' && 'low' in value) {
        return Number(value.low || 0);
    }
    const numeric = Number(value || 0);
    if (!numeric) return 0;
    return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
}

function formatTimestamp(seconds) {
    if (!seconds) return 'unknown time';
    return new Date(seconds * 1000).toLocaleString();
}

function easternDayNumber(seconds) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: EASTERN_TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(seconds * 1000));
    const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    return Math.floor(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)) / 86400000);
}

function describeDateFilter() {
    if (TODAY) return 'today';
    if (DAY_OFFSET !== null) return `day-offset ${DAY_OFFSET}`;
    if (LAST_DAYS !== null) return `last ${LAST_DAYS} day(s)`;
    return 'none';
}

function inDateWindow(seconds) {
    if (!TODAY && DAY_OFFSET === null && LAST_DAYS === null) return true;
    if (!seconds) return false;
    const msgDay = easternDayNumber(seconds);
    const todayDay = easternDayNumber(Math.floor(Date.now() / 1000));
    if (TODAY) return msgDay === todayDay;
    if (DAY_OFFSET !== null) return msgDay === todayDay - DAY_OFFSET;
    return msgDay >= todayDay - (LAST_DAYS - 1) && msgDay <= todayDay;
}

function oldestRequiredDay() {
    const todayDay = easternDayNumber(Math.floor(Date.now() / 1000));
    if (TODAY) return todayDay;
    if (DAY_OFFSET !== null) return todayDay - DAY_OFFSET;
    if (LAST_DAYS !== null) return todayDay - (LAST_DAYS - 1);
    return -Infinity;
}

function getMessageText(m) {
    if (!m) return '[no content]';
    return (
        m.conversation
        || m.extendedTextMessage?.text
        || m.imageMessage?.caption
        || m.videoMessage?.caption
        || m.documentMessage?.caption
        || (m.videoMessage ? '[VIDEO]' : '')
        || (m.imageMessage ? '[IMAGE]' : '')
        || (m.documentMessage ? '[FILE]' : '')
        || (m.audioMessage ? '[AUDIO]' : '')
        || (m.stickerMessage ? '[STICKER]' : '')
        || '[unsupported]'
    );
}

function getSenderLabel(msg) {
    if (!msg?.key) return 'unknown';
    if (msg.key.fromMe) return 'me';
    const raw = msg.pushName || msg.key.participant || msg.key.remoteJid || 'unknown';
    if (msg.pushName) return `~${msg.pushName}`;
    return String(raw).split('@')[0];
}

function messageKey(msg) {
    return `${msg?.key?.remoteJid || ''}:${msg?.key?.id || ''}:${msg?.key?.participant || ''}`;
}

async function resolveTargetJid(sock, target) {
    if (target.includes('@')) return { jid: target, name: target };
    const groupsRaw = await sock.groupFetchAllParticipating();
    const groups = Object.values(groupsRaw || {});
    const norm = normalizeSearchString(target);

    const exact = groups.find((g) => normalizeSearchString(g.subject) === norm);
    if (exact) return { jid: exact.id, name: exact.subject };
    const partial = groups.find((g) => normalizeSearchString(g.subject).includes(norm));
    if (partial) return { jid: partial.id, name: partial.subject };
    throw new Error(`Could not resolve target chat: ${target}`);
}

async function main() {
    if (!fs.existsSync(path.join(AUTH_FOLDER, 'creds.json'))) {
        console.error(`[ERROR] No WhatsApp creds at ${AUTH_FOLDER}. Pair via mudslide first.`);
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestWaWebVersion({});

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: DEBUG ? 'warn' : 'silent' }),
        printQRInTerminal: false,
        // Must match mudslide's browser fingerprint to avoid a 401 on the
        // pre-existing session.
        browser: ['Linux', 'Chrome', '10.15.0'],
        syncFullHistory: true,
        markOnlineOnConnect: false,
    });
    sock.ev.on('creds.update', saveCreds);

    // Collect every message we see for the target chat.
    const byKey = new Map();
    const addMessages = (messages) => {
        for (const m of messages || []) {
            if (!m?.key?.remoteJid) continue;
            if (m.key.remoteJid !== resolvedJid) continue;
            const k = messageKey(m);
            const existing = byKey.get(k);
            if (!existing || getTimestampSeconds(existing.messageTimestamp) <= getTimestampSeconds(m.messageTimestamp)) {
                byKey.set(k, m);
            }
        }
    };

    let resolvedJid = null;
    let historyEventCount = 0;
    let historyMessageCount = 0;

    sock.ev.on('messaging-history.set', ({ messages, progress, syncType, isLatest }) => {
        historyEventCount += 1;
        historyMessageCount += messages?.length || 0;
        const targetCount = (messages || []).filter((m) => m?.key?.remoteJid === resolvedJid).length;
        debug(`history.set events=${historyEventCount} totalMsgs=${historyMessageCount} thisTarget=${targetCount} progress=${progress ?? 'n/a'} syncType=${syncType ?? 'n/a'} isLatest=${isLatest}`);
        addMessages(messages);
    });
    sock.ev.on('messages.upsert', ({ messages }) => addMessages(messages));

    // Wait for connection open.
    await new Promise((resolve, reject) => {
        sock.ev.on('connection.update', (u) => {
            if (u.connection === 'open') return resolve();
            if (u.connection === 'close') {
                const code = u.lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) reject(new Error('Logged out from WhatsApp'));
                else reject(new Error(`Connection closed (${code || 'unknown'}): ${u.lastDisconnect?.error?.message || ''}`));
            }
        });
    });

    const { jid, name } = await resolveTargetJid(sock, TARGET);
    resolvedJid = jid;
    console.log(`Target chat: ${name} (${jid})`);
    console.log(`Date filter: ${describeDateFilter()}`);

    // Phase 1: wait for the initial history sync to settle.
    debug(`Waiting ${INITIAL_SYNC_WAIT_MS}ms for initial history sync...`);
    await new Promise((r) => setTimeout(r, INITIAL_SYNC_WAIT_MS));
    debug(`After initial sync: ${byKey.size} message(s) for target.`);

    // Phase 2: walk backwards by repeatedly asking the phone for older history.
    const cutoffDay = oldestRequiredDay();
    let rounds = 0;
    while (rounds < MAX_HISTORY_ROUNDS) {
        const all = [...byKey.values()].sort(
            (a, b) => getTimestampSeconds(a.messageTimestamp) - getTimestampSeconds(b.messageTimestamp),
        );
        const oldest = all[0];
        if (!oldest) break;

        const oldestTs = getTimestampSeconds(oldest.messageTimestamp);
        debug(`Round ${rounds + 1}: oldest known ${formatTimestamp(oldestTs)} (${all.length} msgs cached).`);

        // Stop once we have history covering the requested date window.
        if (cutoffDay !== -Infinity && easternDayNumber(oldestTs) <= cutoffDay - 1) {
            debug('Reached past the requested date window; stopping backwards walk.');
            break;
        }
        // Stop if no date filter and we already have enough messages.
        if (cutoffDay === -Infinity && all.length >= LIMIT) {
            debug('Cached message count satisfies LIMIT; stopping.');
            break;
        }

        const sizeBefore = byKey.size;
        try {
            await sock.fetchMessageHistory(HISTORY_BATCH_SIZE, oldest.key, oldest.messageTimestamp);
        } catch (err) {
            debug(`fetchMessageHistory error: ${err.message}`);
            break;
        }
        await new Promise((r) => setTimeout(r, HISTORY_WAIT_MS));
        const gained = byKey.size - sizeBefore;
        debug(`Round ${rounds + 1}: gained ${gained} message(s).`);
        if (gained === 0) {
            debug('No new messages returned; phone has no further history to give.');
            break;
        }
        rounds += 1;
    }

    // Final selection.
    const all = [...byKey.values()].sort(
        (a, b) => getTimestampSeconds(a.messageTimestamp) - getTimestampSeconds(b.messageTimestamp),
    );
    const filtered = all.filter((m) => inDateWindow(getTimestampSeconds(m.messageTimestamp)));
    const selected = (TODAY || DAY_OFFSET !== null || LAST_DAYS !== null)
        ? filtered
        : filtered.slice(-LIMIT);

    console.log(`Loaded ${selected.length} message(s) (cache holds ${all.length}, oldest ${all[0] ? formatTimestamp(getTimestampSeconds(all[0].messageTimestamp)) : 'n/a'}).`);
    for (const m of selected) {
        const ts = getTimestampSeconds(m.messageTimestamp);
        console.log(`[${formatTimestamp(ts)}] ${getSenderLabel(m)}: ${getMessageText(m.message).slice(0, 500)}`);
    }

    // IMPORTANT: do NOT call sock.logout() — that invalidates the shared
    // mudslide session. Just close the websocket.
    try { sock.end(undefined); } catch {}
    try { sock.ws?.close?.(); } catch {}
    setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
