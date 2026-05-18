#!/usr/bin/env node
/**
 * List recent messages from a WhatsApp chat using Baileys.
 * Usage: node list_messages.mjs <jid-or-group-name> [limit]
 */
import path from 'path';
import os from 'os';
import {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import P from 'pino';

const AUTH_FOLDER = path.join(os.homedir(), '.local', 'share', 'mudslide');
const TARGET = process.argv[2];
const LIMIT = Number.parseInt(process.argv[3] || '10', 10);

if (!TARGET) {
    console.error('Usage: node list_messages.mjs <jid-or-group-name> [limit]');
    process.exit(1);
}

function normalizeGroups(groups) {
    if (Array.isArray(groups)) {
        return groups;
    }
    if (groups instanceof Map) {
        return [...groups.values()];
    }
    if (groups && typeof groups === 'object') {
        return Object.values(groups);
    }
    return [];
}

function normalizeSearchString(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function levenshteinDistance(left, right) {
    const matrix = Array.from({ length: left.length + 1 }, () => []);
    for (let row = 0; row <= left.length; row += 1) {
        matrix[row][0] = row;
    }
    for (let column = 0; column <= right.length; column += 1) {
        matrix[0][column] = column;
    }
    for (let row = 1; row <= left.length; row += 1) {
        for (let column = 1; column <= right.length; column += 1) {
            const cost = left[row - 1] === right[column - 1] ? 0 : 1;
            matrix[row][column] = Math.min(
                matrix[row - 1][column] + 1,
                matrix[row][column - 1] + 1,
                matrix[row - 1][column - 1] + cost,
            );
        }
    }
    return matrix[left.length][right.length];
}

function scoreSearchMatch(target, candidate) {
    const normalizedTarget = normalizeSearchString(target);
    const normalizedCandidate = normalizeSearchString(candidate);

    if (!normalizedTarget || !normalizedCandidate) {
        return null;
    }

    if (normalizedTarget === normalizedCandidate) {
        return { score: 0 };
    }

    if (normalizedCandidate.startsWith(normalizedTarget) || normalizedTarget.startsWith(normalizedCandidate)) {
        return { score: 1 + Math.abs(normalizedTarget.length - normalizedCandidate.length) };
    }

    if (normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) {
        return { score: 10 + Math.abs(normalizedTarget.length - normalizedCandidate.length) };
    }

    const distance = levenshteinDistance(normalizedTarget, normalizedCandidate);
    const maxDistance = Math.max(1, Math.floor(Math.min(normalizedTarget.length, normalizedCandidate.length) * 0.15));
    if (distance <= maxDistance) {
        return { score: 100 + distance };
    }

    return null;
}

function getMessageText(message) {
    if (!message) {
        return '[no content]';
    }
    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        (message.videoMessage ? '[VIDEO]' : '') ||
        (message.imageMessage ? '[IMAGE]' : '') ||
        (message.documentMessage ? '[FILE]' : '') ||
        (message.audioMessage ? '[AUDIO]' : '') ||
        (message.stickerMessage ? '[STICKER]' : '') ||
        '[unsupported message]'
    );
}

function formatTimestamp(timestamp) {
    const raw = typeof timestamp === 'object' && timestamp !== null && 'low' in timestamp
        ? timestamp.low
        : Number(timestamp || 0);
    if (!raw) {
        return 'unknown time';
    }
    return new Date(raw * 1000).toLocaleString();
}

async function connectSocket() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const messageCache = new Map();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['Chrome (Linux)', '', ''],
        syncFullHistory: true,
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const message of messages || []) {
            const jid = message.key?.remoteJid;
            if (!jid) {
                continue;
            }

            const existing = messageCache.get(jid) || [];
            existing.push(message);
            existing.sort((left, right) => {
                const leftTs = typeof left.messageTimestamp === 'object' && left.messageTimestamp !== null && 'low' in left.messageTimestamp
                    ? left.messageTimestamp.low
                    : Number(left.messageTimestamp || 0);
                const rightTs = typeof right.messageTimestamp === 'object' && right.messageTimestamp !== null && 'low' in right.messageTimestamp
                    ? right.messageTimestamp.low
                    : Number(right.messageTimestamp || 0);
                return leftTs - rightTs;
            });

            if (existing.length > 200) {
                existing.splice(0, existing.length - 200);
            }

            messageCache.set(jid, existing);
        }
    });

    sock.ev.on('messaging-history.set', ({ messages }) => {
        for (const message of messages || []) {
            const jid = message.key?.remoteJid;
            if (!jid) {
                continue;
            }

            const existing = messageCache.get(jid) || [];
            existing.push(message);
            existing.sort((left, right) => {
                const leftTs = typeof left.messageTimestamp === 'object' && left.messageTimestamp !== null && 'low' in left.messageTimestamp
                    ? left.messageTimestamp.low
                    : Number(left.messageTimestamp || 0);
                const rightTs = typeof right.messageTimestamp === 'object' && right.messageTimestamp !== null && 'low' in right.messageTimestamp
                    ? right.messageTimestamp.low
                    : Number(right.messageTimestamp || 0);
                return leftTs - rightTs;
            });

            if (existing.length > 200) {
                existing.splice(0, existing.length - 200);
            }

            messageCache.set(jid, existing);
        }
    });

    await new Promise((resolve, reject) => {
        sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
            if (connection === 'open') {
                resolve();
                return;
            }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    reject(new Error('Logged out from WhatsApp'));
                    return;
                }
                reject(new Error(`Connection closed before sync completed (${statusCode || 'unknown'})`));
            }
        });
    });

    return { sock, messageCache };
}

async function resolveTargetJid(sock, target) {
    if (target.includes('@')) {
        return { jid: target, name: target };
    }

    const groups = normalizeGroups(await sock.groupFetchAllParticipating());
    const rankedGroups = groups
        .map((entry) => {
            const name = entry.subject || entry.id;
            const match = scoreSearchMatch(target, name);
            return match ? { entry, name, ...match } : null;
        })
        .filter(Boolean)
        .sort((left, right) => left.score - right.score || left.name.localeCompare(right.name));

    if (rankedGroups.length > 0) {
        const best = rankedGroups[0];
        return { jid: best.entry.id, name: best.entry.subject || best.entry.id };
    }

    throw new Error(`Could not resolve target chat: ${target}`);
}

async function main() {
    const { sock, messageCache } = await connectSocket();
    console.log('Connected to WhatsApp. Waiting for history sync...');

    await new Promise((resolve) => setTimeout(resolve, 12000));

    const { jid, name } = await resolveTargetJid(sock, TARGET);
    console.log(`Target chat: ${name} (${jid})`);

    const messages = (messageCache.get(jid) || []).slice(-LIMIT);

    if (!messages || messages.length === 0) {
        console.log('No recent messages available in local history yet.');
        process.exit(2);
    }

    const ordered = [...messages].reverse();
    for (const msg of ordered) {
        const sender = (msg.key?.participant || msg.pushName || msg.key?.remoteJid || 'unknown').split('@')[0];
        const text = getMessageText(msg.message);
        console.log(`[${formatTimestamp(msg.messageTimestamp)}] ${sender}: ${text.slice(0, 200)}`);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
