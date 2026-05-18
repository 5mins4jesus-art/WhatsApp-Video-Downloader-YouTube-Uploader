#!/usr/bin/env node
/**
 * List historic messages from a WhatsApp chat or group.
 * Usage: node list_historic_messages.mjs <jid-or-group-name> [limit]
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
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
const LIMIT = Number.parseInt(process.argv[3] || '100', 10);
const HISTORY_BATCH_SIZE = 50;
const HISTORY_WAIT_MS = 4000;
const INITIAL_SYNC_WAIT_MS = 12000;
const CAPTURE_TIMEOUT_MS = 15000;
const DEBUG_DIR = path.join(process.cwd(), 'watch_debug');

if (!TARGET) {
    console.error('Usage: node list_historic_messages.mjs <jid-or-group-name> [limit]');
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
        return { score: 0, exact: true };
    }

    if (normalizedCandidate.startsWith(normalizedTarget) || normalizedTarget.startsWith(normalizedCandidate)) {
        return { score: 1 + Math.abs(normalizedTarget.length - normalizedCandidate.length), exact: false };
    }

    if (normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) {
        return { score: 10 + Math.abs(normalizedTarget.length - normalizedCandidate.length), exact: false };
    }

    const distance = levenshteinDistance(normalizedTarget, normalizedCandidate);
    const maxDistance = Math.max(1, Math.floor(Math.min(normalizedTarget.length, normalizedCandidate.length) * 0.15));
    if (distance <= maxDistance) {
        return { score: 100 + distance, exact: false };
    }

    return null;
}

function getTimestampSeconds(timestamp) {
    if (typeof timestamp === 'object' && timestamp !== null && 'low' in timestamp) {
        return Number(timestamp.low || 0);
    }
    return Number(timestamp || 0);
}

function formatTimestamp(timestamp) {
    const seconds = getTimestampSeconds(timestamp);
    if (!seconds) {
        return 'unknown time';
    }
    return new Date(seconds * 1000).toLocaleString();
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
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        (message.videoMessage ? '[VIDEO]' : '') ||
        (message.imageMessage ? '[IMAGE]' : '') ||
        (message.documentMessage ? '[FILE]' : '') ||
        (message.audioMessage ? '[AUDIO]' : '') ||
        (message.stickerMessage ? '[STICKER]' : '') ||
        '[unsupported message]'
    );
}

function getSenderLabel(message) {
    if (!message?.key) {
        return 'unknown';
    }

    if (message.key.fromMe) {
        return 'me';
    }

    const rawSender = message.key.participant || message.pushName || message.key.remoteJid || 'unknown';
    return String(rawSender).split('@')[0];
}

function printMessages(messages, sourceLabel) {
    console.log(`Loaded ${messages.length} historic message(s) from ${sourceLabel}.`);
    for (const message of messages) {
        const text = getMessageText(message.message);
        console.log(`[${formatTimestamp(message.messageTimestamp)}] ${getSenderLabel(message)}: ${text.slice(0, 500)}`);
    }
}

function getMessageKey(message) {
    const remoteJid = message?.key?.remoteJid || '';
    const id = message?.key?.id || '';
    const participant = message?.key?.participant || '';
    return `${remoteJid}:${id}:${participant}`;
}

function sortMessages(messages) {
    messages.sort((left, right) => {
        const leftTs = getTimestampSeconds(left?.messageTimestamp);
        const rightTs = getTimestampSeconds(right?.messageTimestamp);
        if (leftTs !== rightTs) {
            return leftTs - rightTs;
        }
        return getMessageKey(left).localeCompare(getMessageKey(right));
    });
}

function createMessageCache() {
    const byChat = new Map();

    return {
        add(messages) {
            for (const message of messages || []) {
                const chatId = message?.key?.remoteJid;
                if (!chatId) {
                    continue;
                }

                const existing = byChat.get(chatId) || [];
                const messageKey = getMessageKey(message);
                if (existing.some((entry) => getMessageKey(entry) === messageKey)) {
                    continue;
                }

                existing.push(message);
                sortMessages(existing);
                byChat.set(chatId, existing);
            }
        },
        get(chatId) {
            return [...(byChat.get(chatId) || [])];
        },
        size(chatId) {
            return (byChat.get(chatId) || []).length;
        },
    };
}

function appendDebugJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function createDebugFiles(chatId, chatName) {
    const baseName = sanitizeDebugName(chatId || chatName || 'watch');
    return {
        upsert: path.join(DEBUG_DIR, `${baseName}.messages_upsert.jsonl`),
        history: path.join(DEBUG_DIR, `${baseName}.messaging_history_set.jsonl`),
        connection: path.join(DEBUG_DIR, `${baseName}.connection_update.jsonl`),
    };
}

function sanitizeDebugName(value) {
    return value.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'watch';
}

function extractMessagesFromHistoryEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return [];
    }

    if (Array.isArray(entry.messages)) {
        return entry.messages;
    }

    if (Array.isArray(entry.chats)) {
        return entry.chats.flatMap((chat) => Array.isArray(chat?.messages) ? chat.messages : []);
    }

    if (Array.isArray(entry.conversations)) {
        return entry.conversations.flatMap((chat) => Array.isArray(chat?.messages) ? chat.messages : []);
    }

    return [];
}

function loadOfflineMessagesForChat(chatId, chatName) {
    if (!fs.existsSync(DEBUG_DIR)) {
        return [];
    }

    const historyFiles = fs.readdirSync(DEBUG_DIR)
        .filter((name) => name.endsWith('.messaging_history_set.jsonl') || name.endsWith('.messages_upsert.jsonl'))
        .map((name) => path.join(DEBUG_DIR, name));

    const messages = [];
    const seen = new Set();
    const chatIdPattern = sanitizeDebugName(chatId);
    const chatNamePattern = sanitizeDebugName(chatName);

    for (const filePath of historyFiles) {
        const fileName = path.basename(filePath);
        if (!fileName.startsWith(chatIdPattern) && !fileName.startsWith(chatNamePattern)) {
            continue;
        }

        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                const candidates = Array.isArray(parsed?.messages) ? parsed.messages : extractMessagesFromHistoryEntry(parsed);
                for (const message of candidates) {
                    if (message?.key?.remoteJid !== chatId) {
                        continue;
                    }

                    const key = getMessageKey(message);
                    if (seen.has(key)) {
                        continue;
                    }

                    seen.add(key);
                    messages.push(message);
                }
            } catch {
                // Ignore malformed debug lines.
            }
        }
    }

    sortMessages(messages);
    return messages;
}

async function connectSocket() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const messageCache = createMessageCache();

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
        messageCache.add(messages);
    });
    sock.ev.on('messaging-history.set', ({ messages }) => {
        messageCache.add(messages);
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
        if (rankedGroups.length > 1 && rankedGroups[1].score === best.score && rankedGroups[1].name !== best.name) {
            console.log(`[DEBUG] Multiple group matches for "${target}": ${rankedGroups.slice(0, 5).map((item) => `${item.name} (${item.entry.id}) score=${item.score}`).join('; ')}`);
        }
        return { jid: best.entry.id, name: best.entry.subject || best.entry.id };
    }

    throw new Error(`Could not resolve target chat: ${target}`);
}

async function requestOlderHistory(sock, oldestMessage) {
    const timestamp = getTimestampSeconds(oldestMessage?.messageTimestamp);
    const key = oldestMessage?.key;

    if (!key?.remoteJid || !key?.id || !timestamp) {
        console.log('[DEBUG] Skipping fetchMessageHistory because the oldest message is missing key fields.');
        return false;
    }

    try {
        console.log(`[DEBUG] Requesting older history for ${key.remoteJid} from message ${key.id} at ${formatTimestamp(timestamp)}`);
        await sock.fetchMessageHistory(HISTORY_BATCH_SIZE, key, timestamp);
        console.log('[DEBUG] fetchMessageHistory request completed without throwing.');
        return true;
    } catch (error) {
        console.log(`[DEBUG] fetchMessageHistory failed: ${error.message}`);
        return false;
    }
}

async function captureTargetHistory(sock, chatId, chatName, messageCache) {
    const debugFiles = createDebugFiles(chatId, chatName);
    const capturedMessages = [];

    return new Promise((resolve) => {
        let finished = false;
        let finishTimer = null;
        let globalHistoryEventCount = 0;
        let globalUpsertEventCount = 0;
        let globalHistoryMessageCount = 0;
        let globalUpsertMessageCount = 0;
        const seenHistoryJids = new Set();
        const seenUpsertJids = new Set();

        const collectSeenJids = (messages, targetSet) => {
            for (const message of messages || []) {
                const remoteJid = message?.key?.remoteJid;
                if (remoteJid) {
                    targetSet.add(remoteJid);
                }
            }
        };

        const summarizeSeenJids = (targetSet) => {
            const values = Array.from(targetSet).sort();
            if (values.length === 0) {
                return '(none)';
            }
            const preview = values.slice(0, 10);
            return values.length > preview.length ? `${preview.join(', ')} ... (+${values.length - preview.length} more)` : preview.join(', ');
        };

        const logCaptureDiagnostics = () => {
            console.log(
                `[DEBUG] Global event summary for ${chatName}: historyEvents=${globalHistoryEventCount}, historyMessages=${globalHistoryMessageCount}, upsertEvents=${globalUpsertEventCount}, upsertMessages=${globalUpsertMessageCount}, targetMessages=${capturedMessages.length}`
            );
            console.log(`[DEBUG] Seen history JIDs for ${chatName}: ${summarizeSeenJids(seenHistoryJids)}`);
            console.log(`[DEBUG] Seen upsert JIDs for ${chatName}: ${summarizeSeenJids(seenUpsertJids)}`);
        };

        const finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            if (finishTimer) {
                clearTimeout(finishTimer);
            }
            sock.ev.off('messaging-history.set', historyHandler);
            sock.ev.off('messages.upsert', upsertHandler);
            sock.ev.off('connection.update', connectionHandler);
            logCaptureDiagnostics();
            resolve(capturedMessages);
        };

        const historyHandler = ({ chats, contacts, messages, isLatest, progress, syncType }) => {
            const targetMessages = (messages || []).filter((message) => message?.key?.remoteJid === chatId);
            globalHistoryEventCount += 1;
            globalHistoryMessageCount += messages?.length || 0;
            collectSeenJids(messages, seenHistoryJids);
            console.log(`[DEBUG] messaging-history.set chats=${chats?.length || 0} contacts=${contacts?.length || 0} messages=${messages?.length || 0} targetMessages=${targetMessages.length} isLatest=${Boolean(isLatest)} progress=${progress ?? 'n/a'} syncType=${syncType ?? 'n/a'}`);

            appendDebugJson(debugFiles.history, {
                at: new Date().toISOString(),
                chats: chats || [],
                contacts: contacts || [],
                messages: targetMessages,
                isLatest: Boolean(isLatest),
                progress: progress ?? null,
                syncType: syncType ?? null,
            });

            if (targetMessages.length > 0) {
                messageCache.add(targetMessages);
                capturedMessages.push(...targetMessages);
            }

            if (isLatest) {
                finish();
            }
        };

        const upsertHandler = ({ messages, type }) => {
            const targetMessages = (messages || []).filter((message) => message?.key?.remoteJid === chatId);
            globalUpsertEventCount += 1;
            globalUpsertMessageCount += messages?.length || 0;
            collectSeenJids(messages, seenUpsertJids);
            console.log(`[DEBUG] messages.upsert type=${type || 'n/a'} messages=${messages?.length || 0} targetMessages=${targetMessages.length}`);

            appendDebugJson(debugFiles.upsert, {
                at: new Date().toISOString(),
                type: type || null,
                messages: targetMessages,
            });

            if (targetMessages.length > 0) {
                messageCache.add(targetMessages);
                capturedMessages.push(...targetMessages);
            }
        };

        const connectionHandler = ({ connection, lastDisconnect }) => {
            appendDebugJson(debugFiles.connection, {
                at: new Date().toISOString(),
                connection: connection || null,
                statusCode: lastDisconnect?.error?.output?.statusCode || null,
            });
        };

        sock.ev.on('messaging-history.set', historyHandler);
        sock.ev.on('messages.upsert', upsertHandler);
        sock.ev.on('connection.update', connectionHandler);

        const triggerHistoryRequest = async () => {
            const cachedMessages = messageCache.get(chatId);
            const oldestMessage = cachedMessages[0];

            if (!oldestMessage) {
                console.log(`[DEBUG] No cached anchor message available yet for ${chatName}; explicit fetchMessageHistory request skipped.`);
                return;
            }

            console.log(`[DEBUG] Triggering explicit fetchMessageHistory for ${chatName} using anchor ${oldestMessage.key?.id || 'unknown'}`);
            await requestOlderHistory(sock, oldestMessage);
        };

        void triggerHistoryRequest();

        finishTimer = setTimeout(() => {
            console.log(`[DEBUG] Targeted history capture timed out for ${chatName} after ${CAPTURE_TIMEOUT_MS}ms`);
            finish();
        }, CAPTURE_TIMEOUT_MS);
    });
}

async function loadHistoricMessages(sock, messageCache, chatId, limit) {
    let messages = messageCache.get(chatId);
    let previousCount = -1;

    console.log(`[DEBUG] Initial cached messages for ${chatId}: ${messages.length}`);

    while (messages.length < limit && messages.length !== previousCount && messages.length > 0) {
        previousCount = messages.length;
        const oldestMessage = messages[0];
        const requested = await requestOlderHistory(sock, oldestMessage);
        if (!requested) {
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, HISTORY_WAIT_MS));
        messages = messageCache.get(chatId);
        console.log(`[DEBUG] Cached messages for ${chatId} after history request: ${messages.length}`);
    }

    return messages.slice(-limit);
}

async function main() {
    const { sock, messageCache } = await connectSocket();
    console.log('Connected to WhatsApp. Waiting for initial history sync...');

    await new Promise((resolve) => setTimeout(resolve, INITIAL_SYNC_WAIT_MS));

    const { jid, name } = await resolveTargetJid(sock, TARGET);
    console.log(`Target chat: ${name} (${jid})`);
    console.log(`[DEBUG] Cache size for resolved target after initial wait: ${messageCache.size(jid)}`);

    const capturedMessages = await captureTargetHistory(sock, jid, name, messageCache);
    console.log(`[DEBUG] Targeted capture collected ${capturedMessages.length} messages for ${name}`);

    let messages = await loadHistoricMessages(sock, messageCache, jid, LIMIT);
    let sourceLabel = 'live sync';
    if (!messages.length) {
        messages = loadOfflineMessagesForChat(jid, name).slice(-LIMIT);
        sourceLabel = 'watch_debug fallback';
    }

    if (!messages.length) {
        console.log('No historic messages available in live sync or watch_debug history yet.');
        process.exit(2);
    }

    printMessages(messages, sourceLabel);

    process.exit(0);
}

main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});