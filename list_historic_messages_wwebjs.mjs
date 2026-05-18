#!/usr/bin/env node
/**
 * List WhatsApp chat history using whatsapp-web.js.
 * Usage: node list_historic_messages_wwebjs.mjs <jid-or-group-name> [limit] [--today | --day-offset N | --last-days N]
 */
import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';

const { Client, LocalAuth } = pkg;

const args = process.argv.slice(2);
const TARGET = args[0];
const LIMIT = Number.parseInt(args[1] || '20', 10);
const SESSION_DIR = path.join(process.cwd(), '.wwebjs_auth');
const WEB_CACHE_DIR = path.join(process.cwd(), '.wwebjs_cache');
const EASTERN_TIME_ZONE = 'America/New_York';
const TODAY = args.includes('--today');
const DAY_OFFSET_INDEX = args.indexOf('--day-offset');
const DAY_OFFSET = DAY_OFFSET_INDEX !== -1 ? Number.parseInt(args[DAY_OFFSET_INDEX + 1] || '0', 10) : null;
const LAST_DAYS_INDEX = args.indexOf('--last-days');
const LAST_DAYS = LAST_DAYS_INDEX !== -1 ? Number.parseInt(args[LAST_DAYS_INDEX + 1] || '1', 10) : null;

function printUsage() {
    console.log('Usage: node list_historic_messages_wwebjs.mjs <jid-or-group-name> [limit] [--today | --day-offset N | --last-days N]');
    console.log('');
    console.log('Browser-based WhatsApp history listing using whatsapp-web.js.');
    console.log('Intended to run on Node.js 24+.');
}

if (!TARGET || TARGET === '--help' || TARGET === '-h') {
    printUsage();
    process.exit(1);
}

if ([TODAY, DAY_OFFSET !== null, LAST_DAYS !== null].filter(Boolean).length > 1) {
    console.error('[ERROR] Use only one of --today, --day-offset, or --last-days.');
    process.exit(1);
}

if (DAY_OFFSET !== null && Number.isNaN(DAY_OFFSET)) {
    console.error('[ERROR] --day-offset requires an integer value.');
    process.exit(1);
}

if (LAST_DAYS !== null && (!Number.isInteger(LAST_DAYS) || LAST_DAYS <= 0)) {
    console.error('[ERROR] --last-days requires a positive integer value.');
    process.exit(1);
}

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(WEB_CACHE_DIR, { recursive: true });

function normalizeSearchString(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function getTimestampMs(value) {
    const numeric = Number(value || 0);
    if (!numeric) {
        return 0;
    }
    return numeric > 1e12 ? numeric : numeric * 1000;
}

function formatTimestamp(value) {
    const timestampMs = getTimestampMs(value);
    if (!timestampMs) {
        return 'unknown time';
    }
    return new Date(timestampMs).toLocaleString();
}

function formatEasternTimestampParts(timestampMs) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: EASTERN_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    return Object.fromEntries(
        formatter.formatToParts(new Date(timestampMs))
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value]),
    );
}

function getEasternDateParts(timestampMs) {
    const parts = formatEasternTimestampParts(timestampMs);
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
    };
}

function getEasternDayNumber(timestampMs) {
    const { year, month, day } = getEasternDateParts(timestampMs);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function describeDateFilter() {
    if (TODAY) {
        return 'today';
    }
    if (DAY_OFFSET !== null) {
        return `day-offset ${DAY_OFFSET}`;
    }
    if (LAST_DAYS !== null) {
        return `last ${LAST_DAYS} day(s)`;
    }
    return 'none';
}

function isMessageInSelectedDateWindow(timestampMs) {
    if (!timestampMs) {
        return false;
    }
    if (!TODAY && DAY_OFFSET === null && LAST_DAYS === null) {
        return true;
    }

    const messageDay = getEasternDayNumber(timestampMs);
    const todayDay = getEasternDayNumber(Date.now());

    if (TODAY) {
        return messageDay === todayDay;
    }
    if (DAY_OFFSET !== null) {
        return messageDay === (todayDay - DAY_OFFSET);
    }
    return messageDay >= (todayDay - (LAST_DAYS - 1)) && messageDay <= todayDay;
}

function getMessageText(message) {
    if (!message) {
        return '[no content]';
    }

    if (typeof message.body === 'string' && message.body.trim()) {
        return message.body;
    }

    if (message.type === 'image') {
        return '[IMAGE]';
    }
    if (message.type === 'video') {
        return '[VIDEO]';
    }
    if (message.type === 'document') {
        return '[FILE]';
    }
    if (message.type === 'audio' || message.type === 'ptt') {
        return '[AUDIO]';
    }
    if (message.type === 'sticker') {
        return '[STICKER]';
    }

    return `[${message.type || 'unsupported'}]`;
}

function formatContactLabel(contact) {
    if (!contact) {
        return null;
    }

    const preferredName = contact.pushname || contact.name || contact.shortName || contact.verifiedName;
    if (preferredName) {
        return `~${preferredName}`;
    }

    if (contact.number) {
        return contact.number;
    }

    return null;
}

async function getSenderLabel(message) {
    if (!message) {
        return 'unknown';
    }

    if (message.fromMe) {
        return 'me';
    }

    try {
        const contact = await message.getContact();
        const contactLabel = formatContactLabel(contact);
        if (contactLabel) {
            return contactLabel;
        }
    } catch {
        // Fall back to raw sender identifiers when contact lookup is unavailable.
    }

    const rawSender = message.author || message.notifyName || message.from || 'unknown';
    return String(rawSender).split('@')[0];
}

async function resolveTargetChat(client, target) {
    const chats = await client.getChats();

    if (target.includes('@')) {
        const direct = chats.find((chat) => chat.id?._serialized === target || chat.id?.user === target);
        if (direct) {
            return direct;
        }
    }

    const normalizedTarget = normalizeSearchString(target);
    const exact = chats.find((chat) => normalizeSearchString(chat.name || chat.formattedTitle || chat.id?._serialized) === normalizedTarget);
    if (exact) {
        return exact;
    }

    const partial = chats.find((chat) => normalizeSearchString(chat.name || chat.formattedTitle || chat.id?._serialized).includes(normalizedTarget));
    if (partial) {
        return partial;
    }

    throw new Error(`Could not resolve target chat: ${target}`);
}

async function main() {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'history-list',
            dataPath: SESSION_DIR,
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
        webVersionCache: {
            type: 'local',
            path: WEB_CACHE_DIR,
        },
    });

    client.on('qr', (qr) => {
        console.log('Scan this QR code with WhatsApp:');
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
        console.log('Authenticated with WhatsApp Web.');
    });

    client.on('ready', async () => {
        try {
            console.log('WhatsApp Web client is ready.');
            const chat = await resolveTargetChat(client, TARGET);
            const chatId = chat.id?._serialized || chat.id?.user || TARGET;
            const chatName = chat.name || chat.formattedTitle || chatId;
            console.log(`Target chat: ${chatName} (${chatId})`);
            console.log(`Date filter: ${describeDateFilter()}`);

            // WhatsApp Web streams recent messages asynchronously after 'ready'.
            // Fetching immediately misses messages that haven't arrived yet.
            // Trigger a history sync, then wait until the chat's lastMessage
            // timestamp is stable (no new messages arriving) before fetching.
            try {
                await chat.syncHistory();
            } catch (syncError) {
                console.warn(`[WARN] syncHistory failed: ${syncError.message}`);
            }

            // Poll fetchMessages directly (chat list snapshots are cached and
            // don't reflect freshly-streamed messages). Stop when the newest
            // message timestamp AND the total fetched count are both stable.
            const SETTLE_MS = 5000;
            const MAX_WAIT_MS = 45000;
            const POLL_MS = 2000;
            const waitStart = Date.now();
            let messages = await chat.fetchMessages({ limit: LIMIT });
            let lastTs = messages.length ? getTimestampMs(messages[messages.length - 1].timestamp) : 0;
            let lastCount = messages.length;
            let lastChangeAt = Date.now();
            while (Date.now() - waitStart < MAX_WAIT_MS) {
                await new Promise((r) => setTimeout(r, POLL_MS));
                const next = await chat.fetchMessages({ limit: LIMIT });
                const nextTs = next.length ? getTimestampMs(next[next.length - 1].timestamp) : 0;
                if (nextTs !== lastTs || next.length !== lastCount) {
                    lastTs = nextTs;
                    lastCount = next.length;
                    messages = next;
                    lastChangeAt = Date.now();
                } else if (Date.now() - lastChangeAt >= SETTLE_MS) {
                    break;
                }
            }
            console.log(`Sync settled; newest message at ${formatTimestamp(lastTs / 1000)}.`);
            if (!messages.length) {
                console.log('No messages returned by whatsapp-web.js for this chat.');
                process.exitCode = 2;
                await client.destroy();
                return;
            }

            console.log(`Loaded ${messages.length} message(s) from whatsapp-web.js.`);
            for (const message of messages) {
                const timestampMs = getTimestampMs(message.timestamp);
                if (!isMessageInSelectedDateWindow(timestampMs)) {
                    continue;
                }
                const senderLabel = await getSenderLabel(message);
                console.log(`[${formatTimestamp(message.timestamp)}] ${senderLabel}: ${getMessageText(message).slice(0, 500)}`);
            }

            await client.destroy();
        } catch (error) {
            console.error(`Fatal: ${error.message}`);
            process.exitCode = 1;
            await client.destroy();
        }
    });

    client.on('auth_failure', (message) => {
        console.error(`Authentication failed: ${message}`);
        process.exit(1);
    });

    await client.initialize();
}

main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
});