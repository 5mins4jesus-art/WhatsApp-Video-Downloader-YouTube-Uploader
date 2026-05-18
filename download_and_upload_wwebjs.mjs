#!/usr/bin/env node
/**
 * WhatsApp Video Downloader + YouTube Uploader using whatsapp-web.js.
 *
 * Usage:
 *   node download_and_upload_wwebjs.mjs [--dry-run] [--download-only] [--upload-only] [--limit 50] [--chats "Chat1" "Chat2"]
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
import { google } from 'googleapis';
import open from 'open';

const { Client, LocalAuth, MessageMedia } = pkg;

const DEFAULT_CHATS = [
    'JESUS CHRIST THE ONLY WAY',
    'JESUS CHRIST is the LORD',
    '5 Minutes for Jesus Christ',
];

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloaded_videos');
const METADATA_FILE = path.join(process.cwd(), 'video_metadata.json');
const UPLOAD_LOG = path.join(process.cwd(), 'upload_log.json');
const SESSION_DIR = path.join(process.cwd(), '.wwebjs_auth');
const WEB_CACHE_DIR = path.join(process.cwd(), '.wwebjs_cache');
const WWEBJS_CLIENT_ID = 'history-list';
const YOUTUBE_CLIENT_SECRETS = process.env.YOUTUBE_CLIENT_SECRETS || path.join(process.cwd(), 'youtube_client_secret.json');
const YOUTUBE_TOKEN_FILE = process.env.YOUTUBE_TOKEN_FILE || path.join(process.cwd(), 'youtube_oauth_token.json');
const EASTERN_TIME_ZONE = 'America/New_York';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DOWNLOAD_ONLY = args.includes('--download-only');
const UPLOAD_ONLY = args.includes('--upload-only');
const FORCE_UPLOAD = args.includes('--force-upload');
const ALL_HISTORY = args.includes('--all-history');
const VERIFY_YOUTUBE = args.includes('--verify-youtube');
const REUPLOAD_MISSING_YOUTUBE = args.includes('--reupload-missing-youtube');
const MESSAGE_ID_INDEX = args.indexOf('--message-id');
const TARGET_MESSAGE_ID = MESSAGE_ID_INDEX !== -1 ? String(args[MESSAGE_ID_INDEX + 1] || '').trim() : '';
const limitIndex = args.indexOf('--limit');
const LIMIT = limitIndex !== -1 ? Number.parseInt(args[limitIndex + 1] || '50', 10) : 50;
const TODAY = args.includes('--today');
const DAY_OFFSET_INDEX = args.indexOf('--day-offset');
const DAY_OFFSET = DAY_OFFSET_INDEX !== -1 ? Number.parseInt(args[DAY_OFFSET_INDEX + 1] || '0', 10) : null;
const LAST_DAYS_INDEX = args.indexOf('--last-days');
const LAST_DAYS = LAST_DAYS_INDEX !== -1 ? Number.parseInt(args[LAST_DAYS_INDEX + 1] || '1', 10) : null;
const chatsArgIdx = args.indexOf('--chats');

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

const TARGET_CHATS = chatsArgIdx !== -1
    ? collectFlagValues(args, '--chats')
    : DEFAULT_CHATS;

function printUsage() {
    console.log('Usage: node download_and_upload_wwebjs.mjs [--dry-run] [--download-only] [--upload-only] [--force-upload] [--message-id <id>] [--all-history] [--today | --day-offset N | --last-days N] [--verify-youtube] [--reupload-missing-youtube] [--limit 50] [--chats "Chat1" "Chat2"]');
    console.log('');
    console.log('Browser-based WhatsApp video downloader and YouTube uploader using whatsapp-web.js.');
    console.log('Intended to run on Node.js 24+.');
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

if (MESSAGE_ID_INDEX !== -1 && !TARGET_MESSAGE_ID) {
    console.error('[ERROR] --message-id requires a value.');
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

function loadUploadLog() {
    return loadJson(UPLOAD_LOG, { uploaded: [] });
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

function getEasternTimeZoneAbbreviation(timestampMs) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: EASTERN_TIME_ZONE,
        timeZoneName: 'short',
    });
    const timeZoneName = formatter
        .formatToParts(new Date(timestampMs))
        .find((part) => part.type === 'timeZoneName')?.value || 'ET';
    return timeZoneName.replace(/^GMT[+-]\d+$/, 'ET');
}

function formatEasternTimestampForTitle(timestampMs) {
    const parts = formatEasternTimestampParts(timestampMs);
    const zone = getEasternTimeZoneAbbreviation(timestampMs);
    return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}-${parts.second}-${zone}`;
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

function extractTitleLead(video) {
    const caption = String(video?.caption || '').replace(/\s+/g, ' ').trim();
    if (!caption) {
        return sanitizeFilename(video?.chatName || 'WhatsApp video');
    }

    const firstSegment = caption.split(/[\n|,.;:!?]/)[0]?.trim() || caption;
    const cleaned = firstSegment.replace(/^[@#~\-\s]+/, '').trim();
    if (!cleaned) {
        return sanitizeFilename(video?.chatName || 'WhatsApp video');
    }

    return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 57).trimEnd()}...`;
}

function saveUploadLog(log) {
    saveJson(UPLOAD_LOG, log);
}

function upsertUploadLogEntry(log, entry) {
    const uploaded = Array.isArray(log?.uploaded) ? log.uploaded : [];
    const nextUploaded = uploaded.filter((item) => item?.messageId !== entry?.messageId);
    nextUploaded.push(entry);
    log.uploaded = nextUploaded;
    return log;
}

function clearYouTubeMissingState(entry) {
    if (!entry || typeof entry !== 'object') {
        return entry;
    }

    const nextEntry = { ...entry };
    if (nextEntry.error === 'Logged as uploaded, but video is missing on YouTube') {
        delete nextEntry.error;
    }
    delete nextEntry.youtubeMissingAt;
    delete nextEntry.youtubeMissingVideoId;
    return nextEntry;
}

function loadMetadata() {
    return loadJson(METADATA_FILE, { videos: [], timestamp: null });
}

function saveMetadata(metadata) {
    saveJson(METADATA_FILE, metadata);
}

function getSuccessfulUploadIds(log = loadUploadLog()) {
    return new Set((log.uploaded || []).filter((entry) => entry?.messageId && !entry.error).map((entry) => entry.messageId));
}

function buildVideoFilename(chatName, timestampMs, messageId, extension) {
    const dateStr = formatEasternTimestampForFilename(timestampMs);
    return `${sanitizeFilename(chatName)}_${dateStr}_${messageId}${extension}`;
}

function getVideoExtension(message) {
    const mime = String(message?.mimetype || '').toLowerCase();
    if (mime.includes('mp4')) return '.mp4';
    if (mime.includes('3gp')) return '.3gp';
    if (mime.includes('webm')) return '.webm';
    if (mime.includes('quicktime')) return '.mov';
    return '.mp4';
}

function buildUploadTitle(video) {
    const lead = extractTitleLead(video);
    const timestamp = formatEasternTimestampForTitle(video.timestamp);
    const rawTitle = `${lead} posted on ${timestamp}`;
    return rawTitle.length <= 100 ? rawTitle : `${rawTitle.slice(0, 97).trimEnd()}...`;
}

function buildUploadDescription(video) {
    const lines = [
        `Video from WhatsApp chat: ${video.chatName}`,
        `Date: ${formatEasternTimestampIsoLike(video.timestamp)} ${getEasternTimeZoneAbbreviation(video.timestamp)}`,
        `Original filename: ${video.filename}`,
    ];
    if (video.caption) {
        lines.push('', video.caption);
    }
    return lines.join('\n');
}

function mergeVideosByMessageId(existingVideos, newVideos) {
    const merged = new Map();
    for (const video of existingVideos || []) {
        if (video?.messageId) {
            merged.set(video.messageId, video);
        }
    }
    for (const video of newVideos || []) {
        if (video?.messageId) {
            merged.set(video.messageId, video);
        }
    }
    return [...merged.values()].sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
}

function pruneMetadataVideos(videos, successfulUploadIds = getSuccessfulUploadIds()) {
    return (videos || []).filter((video) => {
        if (!video?.messageId) {
            return false;
        }
        if (!FORCE_UPLOAD && successfulUploadIds.has(video.messageId)) {
            return false;
        }
        return Boolean(video.filepath && fs.existsSync(video.filepath));
    });
}

function filterAlreadyUploadedVideos(videos) {
    if (FORCE_UPLOAD) {
        return videos;
    }
    const successfulUploadIds = getSuccessfulUploadIds();
    return videos.filter((video) => !successfulUploadIds.has(video.messageId));
}

function isVideoInSelectedScope(video, allowedChatNames) {
    if (!video?.messageId) {
        return false;
    }

    if (allowedChatNames.size) {
        const chatName = String(video.chatName || '').trim();
        if (!allowedChatNames.has(chatName)) {
            return false;
        }
    }

    return isMessageInSelectedDateWindow(video.timestamp);
}

function getPendingMetadataVideos(existingMetadata, newVideos, options = {}) {
    const allowedChatNames = new Set((options.targetChats || []).map((chat) => String(chat || '').trim()).filter(Boolean));
    const scopedExistingVideos = (existingMetadata?.videos || []).filter((video) => isVideoInSelectedScope(video, allowedChatNames));
    const scopedNewVideos = (newVideos || []).filter((video) => isVideoInSelectedScope(video, allowedChatNames));
    const mergedVideos = mergeVideosByMessageId(scopedExistingVideos, scopedNewVideos);
    return filterAlreadyUploadedVideos(pruneMetadataVideos(mergedVideos));
}

function getMissingYouTubeUploadCandidates(existingMetadata, options = {}) {
    const uploadLog = loadUploadLog();
    const uploadedEntries = Array.isArray(uploadLog?.uploaded) ? uploadLog.uploaded : [];
    const reconstructedVideos = uploadedEntries
        .filter((entry) => entry?.error === 'Logged as uploaded, but video is missing on YouTube' && entry?.messageId)
        .map((entry) => findVideoByMessageId(existingMetadata, entry.messageId))
        .filter(Boolean);

    const allowedChatNames = new Set((options.targetChats || []).map((chat) => String(chat || '').trim()).filter(Boolean));
    return reconstructedVideos.filter((video) => isVideoInSelectedScope(video, allowedChatNames));
}

function listDownloadDirectories() {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
        return [];
    }

    return fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(DOWNLOAD_DIR, entry.name));
}

function parseTimestampFromFilename(filename) {
    const match = String(filename || '').match(/_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})(?:Z)?_/);
    if (!match) {
        return Date.now();
    }

    const [, datePart, hour, minute, second, millisecond] = match;
    const parsed = new Date(`${datePart}T${hour}:${minute}:${second}.${millisecond}`).getTime();
    return Number.isNaN(parsed) ? Date.now() : parsed;
}

function inferChatNameFromFilename(filename) {
    const normalizedFilename = String(filename || '');
    const knownChats = [...DEFAULT_CHATS].sort((left, right) => right.length - left.length);
    const matchedChat = knownChats.find((chat) => normalizedFilename.startsWith(`${chat}_`));
    if (matchedChat) {
        return matchedChat;
    }

    const timestampIndex = normalizedFilename.indexOf('_20');
    if (timestampIndex > 0) {
        return normalizedFilename.slice(0, timestampIndex);
    }

    return 'unknown';
}

function findVideoByMessageId(existingMetadata, messageId) {
    const metadataVideos = Array.isArray(existingMetadata?.videos) ? existingMetadata.videos : [];
    const metadataMatch = metadataVideos.find((video) => video?.messageId === messageId && video?.filepath && fs.existsSync(video.filepath));
    if (metadataMatch) {
        return metadataMatch;
    }

    const uploadLog = loadUploadLog();
    const uploadedEntries = Array.isArray(uploadLog?.uploaded) ? uploadLog.uploaded : [];
    const logMatch = uploadedEntries.find((entry) => entry?.messageId === messageId && entry?.filename);
    if (!logMatch) {
        return null;
    }

    const candidatePaths = listDownloadDirectories().map((directory) => path.join(directory, logMatch.filename));
    const filepath = candidatePaths.find((candidate) => fs.existsSync(candidate));
    if (!filepath) {
        return null;
    }

    const timestamp = parseTimestampFromFilename(logMatch.filename);
    const chatName = inferChatNameFromFilename(logMatch.filename);

    return {
        filepath,
        filename: logMatch.filename,
        chatName,
        chatId: path.basename(path.dirname(filepath)),
        timestamp: Number.isNaN(timestamp) ? Date.now() : timestamp,
        caption: '',
        mimetype: 'video/mp4',
        size: fs.statSync(filepath).size,
        messageId,
    };
}

function mergeScopedMetadataVideos(existingVideos, newVideos, options = {}) {
    const allowedChatNames = new Set((options.targetChats || []).map((chat) => String(chat || '').trim()).filter(Boolean));
    const preservedVideos = (existingVideos || []).filter((video) => !isVideoInSelectedScope(video, allowedChatNames));
    const scopedExistingVideos = (existingVideos || []).filter((video) => isVideoInSelectedScope(video, allowedChatNames));
    const scopedNewVideos = (newVideos || []).filter((video) => isVideoInSelectedScope(video, allowedChatNames));
    const mergedScopedVideos = pruneMetadataVideos(mergeVideosByMessageId(scopedExistingVideos, scopedNewVideos));
    return [...preservedVideos, ...mergedScopedVideos].sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
}

function loadClientSecrets(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const secrets = parsed.installed || parsed.web || parsed;
    if (!secrets.client_id || !secrets.client_secret) {
        throw new Error(`Invalid OAuth client secrets file: ${filePath}`);
    }
    return secrets;
}

function resolveRedirectUri(secrets) {
    const redirectUris = Array.isArray(secrets.redirect_uris) ? secrets.redirect_uris : [];
    const preferred = redirectUris.find((uri) => uri.startsWith('http://127.0.0.1'))
        || redirectUris.find((uri) => uri.startsWith('http://localhost'));
    if (preferred) {
        const parsed = new URL(preferred);
        const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
        const port = parsed.port || '8787';
        const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/oauth2callback';
        return `${parsed.protocol}//${host}:${port}${pathname}`;
    }
    return 'http://127.0.0.1:8787/oauth2callback';
}

async function waitForOAuthCode(redirectUri, authUrl, listenHost, listenPort) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, redirectUri);
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Authorization failed. You can close this window.');
                server.close();
                reject(new Error(`OAuth authorization failed: ${error}`));
                return;
            }

            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing authorization code. You can close this window.');
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Authorization received. You can close this window and return to the terminal.');
            server.close();
            resolve(code);
        });

        server.on('error', reject);
        server.listen(listenPort, listenHost, async () => {
            console.log('[INFO] Opening browser for Google OAuth consent...');
            console.log(authUrl);
            try {
                await open(authUrl);
            } catch {
                console.log('[INFO] Open the URL above manually if the browser did not launch.');
            }
        });
    });
}

async function getYouTubeAuthClient() {
    if (!fs.existsSync(YOUTUBE_CLIENT_SECRETS)) {
        throw new Error(`OAuth client secrets file not found: ${YOUTUBE_CLIENT_SECRETS}`);
    }

    const secrets = loadClientSecrets(YOUTUBE_CLIENT_SECRETS);
    const redirectUri = resolveRedirectUri(secrets);
    const redirectUrl = new URL(redirectUri);
    const listenHost = redirectUrl.hostname === 'localhost' ? '127.0.0.1' : redirectUrl.hostname;
    const listenPort = Number(redirectUrl.port || 80);
    const oauth2Client = new google.auth.OAuth2(secrets.client_id, secrets.client_secret, redirectUri);

    if (fs.existsSync(YOUTUBE_TOKEN_FILE)) {
        oauth2Client.setCredentials(JSON.parse(fs.readFileSync(YOUTUBE_TOKEN_FILE, 'utf8')));
        return oauth2Client;
    }

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/youtube.upload'],
    });

    const code = await waitForOAuthCode(`${redirectUrl.protocol}//${redirectUrl.host}${redirectUrl.pathname}`, authUrl, listenHost, listenPort);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(YOUTUBE_TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log(`[INFO] Saved OAuth token to ${YOUTUBE_TOKEN_FILE}`);
    return oauth2Client;
}

async function uploadVideoWithOAuth(auth, video, title, description) {
    const youtube = google.youtube({ version: 'v3', auth });
    const response = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
            snippet: { title, description },
            status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
        },
        media: {
            body: fs.createReadStream(video.filepath),
        },
    });

    if (!response.data.id) {
        throw new Error('Upload completed without returning a video ID');
    }

    return {
        videoId: response.data.id,
        url: `https://www.youtube.com/watch?v=${response.data.id}`,
    };
}

async function checkYouTubeVideoExists(auth, videoId) {
    if (!videoId) {
        return false;
    }

    const youtube = google.youtube({ version: 'v3', auth });
    try {
        const response = await youtube.videos.list({
            part: ['id', 'status'],
            id: [videoId],
            maxResults: 1,
        });
        return Array.isArray(response.data.items) && response.data.items.length > 0;
    } catch (error) {
        const status = error?.response?.status;
        if (status === 404) {
            return false;
        }
        if (/insufficient authentication scopes/i.test(String(error?.message || ''))) {
            const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
            const response = await fetch(watchUrl, {
                method: 'GET',
                redirect: 'follow',
            });
            if (!response.ok) {
                return false;
            }

            const html = await response.text();
            if (/Video unavailable|This video isn't available anymore|This video has been removed/i.test(html)) {
                return false;
            }

            return html.includes(videoId);
        }
        throw error;
    }
}

async function reconcileUploadLogWithYouTube(log, auth) {
    const uploaded = Array.isArray(log?.uploaded) ? log.uploaded : [];
    const verifiedUploaded = [];
    let missingCount = 0;

    for (const entry of uploaded) {
        const isYoutubeMissingEntry = entry?.error === 'Logged as uploaded, but video is missing on YouTube';
        if (!entry || (!isYoutubeMissingEntry && entry.error) || !entry.messageId) {
            verifiedUploaded.push(entry);
            continue;
        }

        if (!entry.videoId) {
            verifiedUploaded.push(entry);
            continue;
        }

        const exists = await checkYouTubeVideoExists(auth, entry.videoId);
        if (exists) {
            verifiedUploaded.push({
                ...clearYouTubeMissingState(entry),
                youtubeVerifiedAt: new Date().toISOString(),
            });
            continue;
        }

        missingCount += 1;
        console.warn(`[WARN] Logged YouTube video missing for message ${entry.messageId} (videoId=${entry.videoId}). Requeueing for upload.`);
        verifiedUploaded.push({
            ...entry,
            error: 'Logged as uploaded, but video is missing on YouTube',
            youtubeMissingAt: new Date().toISOString(),
            youtubeMissingVideoId: entry.videoId,
        });
    }

    log.uploaded = verifiedUploaded;
    return { log, missingCount };
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

async function downloadVideosFromChat(chat, downloadedMessageIds) {
    const chatId = chat.id?._serialized || chat.id?.user || 'unknown';
    const chatName = chat.name || chat.formattedTitle || chatId;
    const chatDir = path.join(DOWNLOAD_DIR, sanitizeFilename(chatId));
    ensureDir(chatDir);

    const videos = [];
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
            if (message.type !== 'video') {
                continue;
            }
            if (!serializedId) {
                continue;
            }
            if (downloadedMessageIds.has(serializedId)) {
                console.log(`[SKIP] Already downloaded message ${serializedId} from ${chatName}`);
                continue;
            }

            const timestamp = getTimestampMs(message.timestamp);
            if (!isMessageInSelectedDateWindow(timestamp)) {
                continue;
            }
            const extension = getVideoExtension(message);
            const filename = buildVideoFilename(chatName, timestamp, serializedId, extension);
            const filepath = path.join(chatDir, filename);
            const caption = message.body || '';
            const sender = getSenderLabel(message);

            console.log(`[INFO] Found video ${filename}`);
            console.log(`[INFO]   Sender: ${sender}`);
            console.log(`[INFO]   Caption: ${summarizeCaption(caption)}`);

            if (!DRY_RUN && !UPLOAD_ONLY) {
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
                mimetype: message.mimetype || 'video/mp4',
                size: message._data?.size || null,
                messageId: serializedId,
            };

            videos.push(record);
            downloadedMessageIds.add(serializedId);
        }

        const oldestMessage = messages[messages.length - 1];
        const oldestId = oldestMessage?.id?._serialized;
        if (!ALL_HISTORY || !oldestId || messages.length < LIMIT || newMessagesInPage === 0) {
            break;
        }

        before = oldestId;
    }

    return videos;
}

async function uploadToYouTube(videos) {
    const log = loadUploadLog();
    const auth = DRY_RUN ? null : await getYouTubeAuthClient();

    for (const video of videos) {
        if (!FORCE_UPLOAD && log.uploaded.find((entry) => entry.messageId === video.messageId && !entry.error)) {
            console.log(`[SKIP] Already uploaded: ${video.filename}`);
            continue;
        }

        const title = buildUploadTitle(video);
        const description = buildUploadDescription(video);

        if (!fs.existsSync(video.filepath)) {
            const missingMessage = `Video file not found: ${video.filepath}`;
            console.error(`[ERROR] ${missingMessage}`);
            log.uploaded.push({
                messageId: video.messageId,
                filename: video.filename,
                title,
                uploadedAt: new Date().toISOString(),
                error: missingMessage,
            });
            saveUploadLog(log);
            continue;
        }

        console.log(`[INFO] Uploading to YouTube: ${video.filename}`);
        if (!DRY_RUN) {
            try {
                const output = await uploadVideoWithOAuth(auth, video, title, description);
                console.log(`[SUCCESS] Uploaded: ${video.filename}`);
                upsertUploadLogEntry(log, {
                    messageId: video.messageId,
                    filename: video.filename,
                    title,
                    uploadedAt: new Date().toISOString(),
                    videoId: output.videoId,
                    url: output.url,
                });
                saveUploadLog(log);
            } catch (error) {
                console.error(`[ERROR] Failed to upload ${video.filename}: ${error.message}`);
                upsertUploadLogEntry(log, {
                    messageId: video.messageId,
                    filename: video.filename,
                    title,
                    uploadedAt: new Date().toISOString(),
                    error: error.message,
                });
                saveUploadLog(log);
            }
        } else {
            console.log(`[DRY-RUN] Would upload: ${video.filename}`);
        }
    }
}

async function main() {
    console.log('========================================');
    console.log('WhatsApp Web Video Downloader + YouTube Uploader');
    console.log('========================================');
    console.log(`[CONFIG] Target chats: ${TARGET_CHATS.join(', ')}`);
    console.log(`[CONFIG] Limit per chat: ${LIMIT}`);
    console.log(`[CONFIG] All history: ${ALL_HISTORY}`);
    console.log(`[CONFIG] Date filter: ${describeDateFilter()}`);
    console.log(`[CONFIG] Dry run: ${DRY_RUN}`);
    console.log(`[CONFIG] Force upload: ${FORCE_UPLOAD}`);
    console.log(`[CONFIG] Verify YouTube: ${VERIFY_YOUTUBE || REUPLOAD_MISSING_YOUTUBE}`);
    if (TARGET_MESSAGE_ID) {
        console.log(`[CONFIG] Target message ID: ${TARGET_MESSAGE_ID}`);
    }
    console.log('========================================');

    ensureDir(DOWNLOAD_DIR);

    let client;
    try {
        client = await connectWhatsAppWeb();
        if ((VERIFY_YOUTUBE || REUPLOAD_MISSING_YOUTUBE) && !DRY_RUN) {
            console.log('[STEP] Verifying logged YouTube videos still exist...');
            const auth = await getYouTubeAuthClient();
            const currentLog = loadUploadLog();
            const { log: reconciledLog, missingCount } = await reconcileUploadLogWithYouTube(currentLog, auth);
            saveUploadLog(reconciledLog);
            console.log(`[INFO] YouTube verification complete. Missing logged videos: ${missingCount}`);
        }

        const downloadedMessageIds = new Set([
            ...getSuccessfulUploadIds(),
            ...(loadMetadata().videos || []).map((video) => video?.messageId).filter(Boolean),
        ]);

        const existingMetadata = loadMetadata();
        const allVideos = [];

        for (const target of TARGET_CHATS) {
            const chat = await resolveTargetChat(client, target);
            const videos = await downloadVideosFromChat(chat, downloadedMessageIds);
            allVideos.push(...videos);
        }
        const nextMetadataVideos = mergeScopedMetadataVideos(existingMetadata.videos, allVideos, {
            targetChats: TARGET_CHATS,
        });

        saveMetadata({
            videos: nextMetadataVideos,
            timestamp: new Date().toISOString(),
        });

        console.log(`[INFO] Total videos found: ${allVideos.length}`);

        if (!DOWNLOAD_ONLY) {
            const videosToUpload = TARGET_MESSAGE_ID
                ? (() => {
                    const targetVideo = findVideoByMessageId(existingMetadata, TARGET_MESSAGE_ID);
                    if (!targetVideo) {
                        throw new Error(`Could not find local video for message ID: ${TARGET_MESSAGE_ID}`);
                    }
                    if (TARGET_CHATS.length && !TARGET_CHATS.includes(targetVideo.chatName)) {
                        throw new Error(`Message ID ${TARGET_MESSAGE_ID} belongs to chat "${targetVideo.chatName}", which is outside the selected --chats scope.`);
                    }
                    return [targetVideo];
                })()
                : mergeVideosByMessageId(
                    getPendingMetadataVideos(existingMetadata, allVideos, {
                        targetChats: TARGET_CHATS,
                    }),
                    getMissingYouTubeUploadCandidates(existingMetadata, {
                        targetChats: TARGET_CHATS,
                    }),
                );
            console.log(`[INFO] Total videos pending upload: ${videosToUpload.length}`);
            await uploadToYouTube(videosToUpload);
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