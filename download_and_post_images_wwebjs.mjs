#!/usr/bin/env node
/**
 * WhatsApp Image Downloader + YouTube post manifest builder using whatsapp-web.js.
 *
 * Usage:
 *   node download_and_post_images_wwebjs.mjs [--dry-run] [--download-only] [--post-only] [--all-history] [--limit 50] [--chats "Chat1" "Chat2"]
 */

import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';

const { Client, LocalAuth, MessageMedia } = pkg;

const DEFAULT_CHATS = [
    'JESUS CHRIST THE ONLY WAY',
    'JESUS CHRIST is the LORD',
    '5 Minutes for Jesus Christ',
];

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloaded_images');
const METADATA_FILE = path.join(process.cwd(), 'image_metadata.json');
const POST_LOG = path.join(process.cwd(), 'youtube_post_log.json');
const POST_QUEUE_DIR = path.join(process.cwd(), 'youtube_post_queue');
const SESSION_DIR = path.join(process.cwd(), '.wwebjs_auth');
const WEB_CACHE_DIR = path.join(process.cwd(), '.wwebjs_cache');
const WWEBJS_CLIENT_ID = 'history-list';
const MAX_IMAGES_PER_POST = 10;
const EASTERN_TIME_ZONE = 'America/New_York';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DOWNLOAD_ONLY = args.includes('--download-only');
const POST_ONLY = args.includes('--post-only');
const ALL_HISTORY = args.includes('--all-history');
const limitIndex = args.indexOf('--limit');
const LIMIT = limitIndex !== -1 ? Number.parseInt(args[limitIndex + 1] || '50', 10) : 50;
const TODAY = args.includes('--today');
const DAY_OFFSET_INDEX = args.indexOf('--day-offset');
const DAY_OFFSET = DAY_OFFSET_INDEX !== -1 ? Number.parseInt(args[DAY_OFFSET_INDEX + 1] || '0', 10) : null;
const LAST_DAYS_INDEX = args.indexOf('--last-days');
const LAST_DAYS = LAST_DAYS_INDEX !== -1 ? Number.parseInt(args[LAST_DAYS_INDEX + 1] || '1', 10) : null;

function collectFlagValues(argv, flagName) {
    const startIndex = argv.indexOf(flagName);
    if (startIndex === -1) {
        return [];
    }

    const values = [];
    for (let index = startIndex + 1; index < argv.length; index += 1) {
        const value = argv[index];
        if (value.startsWith('--')) {
            break;
        }
        values.push(value);
    }
    return values;
}

const TARGET_CHATS = args.includes('--chats')
    ? collectFlagValues(args, '--chats')
    : DEFAULT_CHATS;

function printUsage() {
    console.log('Usage: node download_and_post_images_wwebjs.mjs [--dry-run] [--download-only] [--post-only] [--all-history] [--today | --day-offset N | --last-days N] [--limit 50] [--chats "Chat1" "Chat2"]');
    console.log('');
    console.log('Browser-based WhatsApp image downloader and YouTube post manifest builder using whatsapp-web.js.');
    console.log('This script downloads historical images and groups them into post batches of up to 10 images.');
}

if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
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

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function sanitizeFilename(name) {
    return String(name || 'unknown').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

function normalizeSearchString(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function levenshteinDistance(left, right) {
    const a = String(left || '');
    const b = String(right || '');

    if (!a.length) {
        return b.length;
    }
    if (!b.length) {
        return a.length;
    }

    const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let row = 0; row <= a.length; row += 1) {
        matrix[row][0] = row;
    }
    for (let column = 0; column <= b.length; column += 1) {
        matrix[0][column] = column;
    }

    for (let row = 1; row <= a.length; row += 1) {
        for (let column = 1; column <= b.length; column += 1) {
            const cost = a[row - 1] === b[column - 1] ? 0 : 1;
            matrix[row][column] = Math.min(
                matrix[row - 1][column] + 1,
                matrix[row][column - 1] + 1,
                matrix[row - 1][column - 1] + cost,
            );
        }
    }

    return matrix[a.length][b.length];
}

function getChatSearchName(chat) {
    return chat.name || chat.formattedTitle || chat.id?._serialized || chat.id?.user || '';
}

function scoreChatMatch(target, candidate) {
    const normalizedTarget = normalizeSearchString(target);
    const normalizedCandidate = normalizeSearchString(candidate);

    if (!normalizedCandidate) {
        return Number.POSITIVE_INFINITY;
    }
    if (normalizedCandidate === normalizedTarget) {
        return -1000;
    }
    if (normalizedCandidate.includes(normalizedTarget)) {
        return normalizedCandidate.length - normalizedTarget.length;
    }
    if (normalizedTarget.includes(normalizedCandidate)) {
        return 100 + (normalizedTarget.length - normalizedCandidate.length);
    }
    return 1000 + levenshteinDistance(normalizedTarget, normalizedCandidate);
}

function getTimestampMs(value) {
    const numeric = Number(value || 0);
    if (!numeric) {
        return Date.now();
    }
    return numeric > 1e12 ? numeric : numeric * 1000;
}

function getSenderLabel(message) {
    if (!message) {
        return 'unknown';
    }
    if (message.fromMe) {
        return 'me';
    }
    const rawSender = message.author || message.notifyName || message.from || 'unknown';
    return String(rawSender).split('@')[0];
}

function summarizeCaption(text, maxLength = 120) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '[no caption]';
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength - 3)}...`;
}

function loadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) {
        return fallback;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function saveJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadMetadata() {
    return loadJson(METADATA_FILE, { images: [], timestamp: null });
}

function saveMetadata(metadata) {
    saveJson(METADATA_FILE, metadata);
}

function loadPostLog() {
    return loadJson(POST_LOG, { posts: [] });
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
    const parts = Object.fromEntries(
        formatter.formatToParts(new Date(timestampMs))
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value]),
    );
    return parts;
}

function formatEasternTimestampForFilename(timestampMs) {
    const parts = formatEasternTimestampParts(timestampMs);
    const milliseconds = String(timestampMs % 1000).padStart(3, '0');
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}-${milliseconds}`;
}

function formatEasternTimestampIsoLike(timestampMs) {
    const parts = formatEasternTimestampParts(timestampMs);
    const milliseconds = String(timestampMs % 1000).padStart(3, '0');
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}`;
}

function formatEasternDate(timestampMs) {
    const parts = formatEasternTimestampParts(timestampMs);
    return `${parts.year}-${parts.month}-${parts.day}`;
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

function savePostLog(log) {
    saveJson(POST_LOG, log);
}

function getPostedMessageIds(log = loadPostLog()) {
    return new Set((log.posts || [])
        .filter((entry) => Array.isArray(entry?.messageIds) && !entry.error)
        .flatMap((entry) => entry.messageIds));
}

function getDownloadedMessageIds(metadata = loadMetadata()) {
    return new Set((metadata.images || []).map((image) => image?.messageId).filter(Boolean));
}

function getImageExtension(message) {
    const mime = String(message?.mimetype || '').toLowerCase();
    if (mime.includes('png')) return '.png';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('gif')) return '.gif';
    if (mime.includes('heic')) return '.heic';
    if (mime.includes('heif')) return '.heif';
    return '.jpg';
}

function buildImageFilename(chatName, timestampMs, messageId, extension) {
    const dateStr = formatEasternTimestampForFilename(timestampMs);
    return `${sanitizeFilename(chatName)}_${dateStr}_${messageId}${extension}`;
}

function mergeImagesByMessageId(existingImages, newImages) {
    const merged = new Map();
    for (const image of existingImages || []) {
        if (image?.messageId) {
            merged.set(image.messageId, image);
        }
    }
    for (const image of newImages || []) {
        if (image?.messageId) {
            merged.set(image.messageId, image);
        }
    }
    return [...merged.values()].sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
}

function pruneMetadataImages(images, postedMessageIds = getPostedMessageIds()) {
    return (images || []).filter((image) => {
        if (!image?.messageId) {
            return false;
        }
        if (postedMessageIds.has(image.messageId)) {
            return false;
        }
        return Boolean(image.filepath && fs.existsSync(image.filepath));
    });
}

function isImageInSelectedScope(image, allowedChatNames) {
    if (!image?.messageId) {
        return false;
    }

    if (allowedChatNames.size) {
        const chatName = String(image.chatName || '').trim();
        if (!allowedChatNames.has(chatName)) {
            return false;
        }
    }

    return isMessageInSelectedDateWindow(image.timestamp);
}

function mergeScopedMetadataImages(existingImages, newImages, options = {}) {
    const allowedChatNames = new Set((options.targetChats || []).map((chat) => String(chat || '').trim()).filter(Boolean));
    const preservedImages = (existingImages || []).filter((image) => !isImageInSelectedScope(image, allowedChatNames));
    const scopedExistingImages = (existingImages || []).filter((image) => isImageInSelectedScope(image, allowedChatNames));
    const scopedNewImages = (newImages || []).filter((image) => isImageInSelectedScope(image, allowedChatNames));
    const mergedScopedImages = pruneMetadataImages(mergeImagesByMessageId(scopedExistingImages, scopedNewImages));
    return [...preservedImages, ...mergedScopedImages].sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
}

function getScopedPendingMetadataImages(existingMetadata, newImages, options = {}) {
    const allowedChatNames = new Set((options.targetChats || []).map((chat) => String(chat || '').trim()).filter(Boolean));
    const scopedExistingImages = (existingMetadata?.images || []).filter((image) => isImageInSelectedScope(image, allowedChatNames));
    const scopedNewImages = (newImages || []).filter((image) => isImageInSelectedScope(image, allowedChatNames));
    return pruneMetadataImages(mergeImagesByMessageId(scopedExistingImages, scopedNewImages));
}

function buildPostTitle(chatName, images) {
    const first = images[0];
    const last = images[images.length - 1];
    const start = formatEasternDate(first.timestamp);
    const end = formatEasternDate(last.timestamp);
    const base = `${chatName} pictures ${start}${start === end ? '' : ` to ${end}`}`;
    return base.length <= 100 ? base : `${base.slice(0, 97).trimEnd()}...`;
}

function buildPostText(chatName, images) {
    const lines = [
        `Pictures from WhatsApp chat: ${chatName}`,
        `Image count: ${images.length}`,
        '',
    ];

    for (const image of images) {
        lines.push(`- ${formatEasternTimestampIsoLike(image.timestamp)} ET | ${image.sender} | ${summarizeCaption(image.caption, 160)}`);
    }

    return lines.join('\n').trim();
}

function buildPostBatchId(chatId, firstMessageId, lastMessageId) {
    return `${sanitizeFilename(chatId)}__${sanitizeFilename(firstMessageId)}__${sanitizeFilename(lastMessageId)}`;
}

function buildPostManifest(batchId, chatName, chatId, images) {
    return {
        batchId,
        chatName,
        chatId,
        imageCount: images.length,
        title: buildPostTitle(chatName, images),
        text: buildPostText(chatName, images),
        messageIds: images.map((image) => image.messageId),
        createdAt: new Date().toISOString(),
        images: images.map((image) => ({
            messageId: image.messageId,
            filename: image.filename,
            filepath: image.filepath,
            timestamp: image.timestamp,
            sender: image.sender,
            caption: image.caption,
            mimetype: image.mimetype,
            size: image.size,
        })),
        posting: {
            platform: 'youtube-community-post',
            status: 'pending-manual-publish',
            maxImagesPerPost: MAX_IMAGES_PER_POST,
            note: 'YouTube does not provide a supported public Data API for creating image community posts. Publish this batch manually in YouTube Studio using the listed files.',
        },
    };
}

function createPostBatches(images, postedMessageIds) {
    const pendingImages = images.filter((image) => !postedMessageIds.has(image.messageId));
    const grouped = new Map();

    for (const image of pendingImages) {
        const key = image.chatId;
        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key).push(image);
    }

    const manifests = [];
    for (const [chatId, chatImages] of grouped.entries()) {
        chatImages.sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
        for (let index = 0; index < chatImages.length; index += MAX_IMAGES_PER_POST) {
            const batchImages = chatImages.slice(index, index + MAX_IMAGES_PER_POST);
            if (!batchImages.length) {
                continue;
            }
            const batchId = buildPostBatchId(chatId, batchImages[0].messageId, batchImages[batchImages.length - 1].messageId);
            manifests.push(buildPostManifest(batchId, batchImages[0].chatName, chatId, batchImages));
        }
    }

    return manifests;
}

function writePostManifest(manifest) {
    ensureDir(POST_QUEUE_DIR);
    const manifestPath = path.join(POST_QUEUE_DIR, `${manifest.batchId}.json`);
    saveJson(manifestPath, manifest);
    return manifestPath;
}

function recordPostBatch(log, manifest, manifestPath) {
    if (log.posts.find((entry) => entry.batchId === manifest.batchId && !entry.error)) {
        return false;
    }

    log.posts.push({
        batchId: manifest.batchId,
        chatName: manifest.chatName,
        chatId: manifest.chatId,
        imageCount: manifest.imageCount,
        messageIds: manifest.messageIds,
        manifestPath,
        createdAt: manifest.createdAt,
        status: manifest.posting.status,
    });
    return true;
}

async function connectWhatsAppWeb() {
    ensureDir(SESSION_DIR);
    ensureDir(WEB_CACHE_DIR);

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: WWEBJS_CLIENT_ID,
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
        console.log('[INFO] WhatsApp Web requested QR authentication.');
        console.log('Scan this QR code with WhatsApp:');
        qrcode.generate(qr, { small: true });
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`[INFO] WhatsApp Web loading: ${percent}% ${message || ''}`.trim());
    });

    client.on('authenticated', () => {
        console.log('Authenticated with WhatsApp Web.');
    });

    client.on('ready', () => {
        console.log('[INFO] WhatsApp Web client emitted ready.');
    });

    client.on('disconnected', (reason) => {
        console.log(`[WARN] WhatsApp Web disconnected: ${reason || 'unknown reason'}`);
    });

    client.on('change_state', (state) => {
        console.log(`[INFO] WhatsApp Web state changed: ${state}`);
    });

    await new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.once('auth_failure', (message) => reject(new Error(`Authentication failed: ${message}`)));
        client.initialize().catch(reject);
    });

    console.log('[SUCCESS] Connected to WhatsApp Web.');
    return client;
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
    const exact = chats.find((chat) => normalizeSearchString(getChatSearchName(chat)) === normalizedTarget);
    if (exact) {
        return exact;
    }

    const partial = chats.find((chat) => normalizeSearchString(getChatSearchName(chat)).includes(normalizedTarget));
    if (partial) {
        return partial;
    }

    const rankedCandidates = chats
        .map((chat) => ({
            chat,
            name: getChatSearchName(chat),
            score: scoreChatMatch(target, getChatSearchName(chat)),
        }))
        .filter((entry) => entry.name)
        .sort((left, right) => left.score - right.score)
        .slice(0, 5)
        .map((entry) => `${entry.name} (${entry.chat.id?._serialized || 'unknown'})`);

    const hint = rankedCandidates.length ? ` Closest matches: ${rankedCandidates.join('; ')}` : '';
    throw new Error(`Could not resolve target chat: ${target}.${hint}`);
}

async function downloadImagesFromChat(chat, downloadedMessageIds, postedMessageIds) {
    const chatId = chat.id?._serialized || chat.id?.user || 'unknown';
    const chatName = chat.name || chat.formattedTitle || chatId;
    const chatDir = path.join(DOWNLOAD_DIR, sanitizeFilename(chatId));
    ensureDir(chatDir);

    const images = [];
    const seenMessageIds = new Set();
    let before;
    let page = 0;

    while (true) {
        page += 1;
        const fetchOptions = { limit: LIMIT };
        if (before) {
            fetchOptions.before = before;
        }

        console.log(`[INFO] Fetching page ${page} (${LIMIT} messages) from ${chatName} (${chatId})${before ? ` before ${before}` : ''}`);
        const messages = await chat.fetchMessages(fetchOptions);
        if (!messages.length) {
            break;
        }

        let newMessagesInPage = 0;

        for (const message of messages) {
            const serializedId = message.id?._serialized;
            if (serializedId && seenMessageIds.has(serializedId)) {
                continue;
            }
            if (serializedId) {
                seenMessageIds.add(serializedId);
            }
            newMessagesInPage += 1;

            if (!message.hasMedia) {
                continue;
            }
            if (message.type !== 'image') {
                continue;
            }
            if (!serializedId) {
                continue;
            }
            if (postedMessageIds.has(serializedId)) {
                console.log(`[SKIP] Already queued as posted message ${serializedId} from ${chatName}`);
                continue;
            }

            const timestamp = getTimestampMs(message.timestamp);
            if (!isMessageInSelectedDateWindow(timestamp)) {
                continue;
            }
            const extension = getImageExtension(message);
            const filename = buildImageFilename(chatName, timestamp, serializedId, extension);
            const filepath = path.join(chatDir, filename);
            const caption = message.body || '';
            const sender = getSenderLabel(message);

            console.log(`[INFO] Found image ${filename}`);
            console.log(`[INFO]   Sender: ${sender}`);
            console.log(`[INFO]   Caption: ${summarizeCaption(caption)}`);

            if (!DRY_RUN && !POST_ONLY && !downloadedMessageIds.has(serializedId)) {
                const media = await message.downloadMedia();
                if (!(media instanceof MessageMedia) || !media.data) {
                    console.log(`[WARN] Could not download media for message ${serializedId}`);
                    continue;
                }
                fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));
                console.log(`[SUCCESS] Downloaded ${filename}`);
            }

            const record = {
                filepath,
                filename,
                chatName,
                chatId,
                timestamp,
                caption,
                sender,
                mimetype: message.mimetype || 'image/jpeg',
                size: message._data?.size || null,
                messageId: serializedId,
            };

            images.push(record);
            downloadedMessageIds.add(serializedId);
        }

        const oldestMessage = messages[messages.length - 1];
        const oldestId = oldestMessage?.id?._serialized;
        if (!ALL_HISTORY || !oldestId || messages.length < LIMIT || newMessagesInPage === 0) {
            break;
        }

        before = oldestId;
    }

    return images;
}

function buildPendingPostQueue(images) {
    const postLog = loadPostLog();
    const postedMessageIds = getPostedMessageIds(postLog);
    const manifests = createPostBatches(images, postedMessageIds);

    let createdCount = 0;
    for (const manifest of manifests) {
        const manifestPath = writePostManifest(manifest);
        const created = recordPostBatch(postLog, manifest, manifestPath);
        if (created) {
            createdCount += 1;
            console.log(`[SUCCESS] Created post batch ${manifest.batchId} with ${manifest.imageCount} images`);
            console.log(`[INFO]   Manifest: ${manifestPath}`);
        } else {
            console.log(`[SKIP] Post batch already recorded: ${manifest.batchId}`);
        }
    }

    if (!DRY_RUN) {
        savePostLog(postLog);
    }

    return { manifests, createdCount };
}

async function main() {
    console.log('========================================');
    console.log('WhatsApp Web Image Downloader + YouTube Post Queue Builder');
    console.log('========================================');
    console.log(`[CONFIG] Target chats: ${TARGET_CHATS.join(', ')}`);
    console.log(`[CONFIG] Limit per chat: ${LIMIT}`);
    console.log(`[CONFIG] All history: ${ALL_HISTORY}`);
    console.log(`[CONFIG] Date filter: ${describeDateFilter()}`);
    console.log(`[CONFIG] Dry run: ${DRY_RUN}`);
    console.log('========================================');

    ensureDir(DOWNLOAD_DIR);
    ensureDir(POST_QUEUE_DIR);

    let client;
    try {
        const existingMetadata = loadMetadata();
        const postLog = loadPostLog();
        const downloadedMessageIds = new Set([
            ...getDownloadedMessageIds(existingMetadata),
            ...getPostedMessageIds(postLog),
        ]);
        const postedMessageIds = getPostedMessageIds(postLog);
        const allImages = [];

        if (!POST_ONLY) {
            client = await connectWhatsAppWeb();
            for (const target of TARGET_CHATS) {
                const chat = await resolveTargetChat(client, target);
                const images = await downloadImagesFromChat(chat, downloadedMessageIds, postedMessageIds);
                allImages.push(...images);
            }

            saveMetadata({
                images: mergeScopedMetadataImages(existingMetadata.images, allImages, {
                    targetChats: TARGET_CHATS,
                }),
                timestamp: new Date().toISOString(),
            });
        }

        const metadataImages = loadMetadata().images || [];
        const queueSource = getScopedPendingMetadataImages({ images: metadataImages }, allImages, {
            targetChats: TARGET_CHATS,
        });
        console.log(`[INFO] Total images found this run: ${allImages.length}`);

        if (!DOWNLOAD_ONLY) {
            const { manifests, createdCount } = buildPendingPostQueue(queueSource);
            console.log(`[INFO] Total post batches considered: ${manifests.length}`);
            console.log(`[INFO] New post batches created: ${createdCount}`);
        }

        console.log('[DONE] Process complete!');
    } finally {
        if (client) {
            try {
                await client.destroy();
            } catch (error) {
                console.warn(`[WARN] Failed to destroy WhatsApp Web client cleanly: ${error.message}`);
            }
        }
    }
}

main().catch((error) => {
    console.error(`[FATAL] ${error.message}`);
    process.exit(1);
});