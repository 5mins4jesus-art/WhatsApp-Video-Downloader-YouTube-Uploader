#!/usr/bin/env node
/**
 * WhatsApp Video Downloader + YouTube Uploader
 * 
 * Downloads all videos from specified WhatsApp chats and uploads them to YouTube as public.
 * 
 * Usage:
 *   node download_and_upload.mjs [--dry-run] [--chats "Chat1" "Chat2" ...]
 * 
 * Environment variables:
 *   YOUTUBE_CLIENT_SECRETS - Path to Google OAuth client JSON (default: ./youtube_client_secret.json)
 *   YOUTUBE_TOKEN_FILE - Path to cached Google OAuth token JSON (default: ./youtube_oauth_token.json)
 *   MUDSLIDE_CACHE_FOLDER - Path to mudslide auth cache (default: ~/.local/share/mudslide)
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import { google } from 'googleapis';
import open from 'open';

// ============ CONFIGURATION ============
const DEFAULT_CHATS = [
  'JESUS CHRIST THE ONLY WAY',
  'JESUS CHRIST is the LORD',
  '5 Minutes for Jesus Christ',
];

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloaded_videos');
const METADATA_FILE = path.join(process.cwd(), 'video_metadata.json');
const DEBUG_DIR = path.join(process.cwd(), 'watch_debug');

// Get timestamp string in Eastern Time (ISO format with EDT/EST offset)
function getEasternTimestamp() {
  const now = new Date();
  const easternTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offset = -easternTime.getTimezoneOffset() / 60;
  const tzAbbr = offset === -4 ? 'EDT' : offset === -5 ? 'EST' : 'GMT';
  const pad = (n) => String(n).padStart(2, '0');
  return `${easternTime.getFullYear()}-${pad(easternTime.getMonth() + 1)}-${pad(easternTime.getDate())}_` +
         `${pad(easternTime.getHours())}-${pad(easternTime.getMinutes())}-${pad(easternTime.getSeconds())}_${tzAbbr}`;
}

const UPLOAD_LOG = path.join(process.cwd(), 'upload_log.json');

// ============ ARGUMENT PARSING ============
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DOWNLOAD_ONLY = args.includes('--download-only');
const CAPTURE_ONLY = args.includes('--capture-only');
const UPLOAD_ONLY = args.includes('--upload-only');
const FORCE_CAPTURE = args.includes('--force-capture');
const HISTORY_WAIT_MS = Number.parseInt(process.env.HISTORY_WAIT_MS || '45000', 10);
const HISTORY_CACHE_MAX_AGE_MS = Number.parseInt(process.env.HISTORY_CACHE_MAX_AGE_MS || String(6 * 60 * 60 * 1000), 10);
const chatsArgIdx = args.indexOf('--chats');
const chatJidsArgIdx = args.indexOf('--chat-jids');
const TARGET_CHATS = chatJidsArgIdx !== -1 && chatsArgIdx === -1
  ? []
  : chatsArgIdx !== -1 
  ? args.slice(chatsArgIdx + 1).filter(a => !a.startsWith('--'))
  : DEFAULT_CHATS;
const TARGET_CHAT_JIDS = chatJidsArgIdx !== -1
  ? args.slice(chatJidsArgIdx + 1).filter(a => !a.startsWith('--'))
  : [];

const AUTH_FOLDER = process.env.MUDSLIDE_CACHE_FOLDER || path.join(os.homedir(), '.local', 'share', 'mudslide');
const YOUTUBE_CLIENT_SECRETS = process.env.YOUTUBE_CLIENT_SECRETS || path.join(process.cwd(), 'youtube_client_secret.json');
const YOUTUBE_TOKEN_FILE = process.env.YOUTUBE_TOKEN_FILE || path.join(process.cwd(), 'youtube_oauth_token.json');

// ============ HELPERS ============
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

function sanitizeDebugName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'watch';
}

function appendDebugJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function loadUploadLog() {
  if (!fs.existsSync(UPLOAD_LOG)) {
    console.log(`[DEBUG] Upload log file ${UPLOAD_LOG} does not exist, returning empty log`);
    return { uploaded: [] };
  }
  try {
    const log = JSON.parse(fs.readFileSync(UPLOAD_LOG, 'utf-8'));
    console.log(`[DEBUG] Loaded upload log with ${log.uploaded?.length || 0} entries`);
    return log;
  } catch (err) {
    console.warn(`[WARN] Could not load upload log from ${UPLOAD_LOG}: ${err.message}`);
    return { uploaded: [] };
  }
}

function saveUploadLog(newLog) {
  console.log(`[DEBUG] Saving upload log with ${newLog.uploaded?.length || 0} entries`);

  // Load existing log
  const existingLog = loadUploadLog();
  console.log(`[DEBUG] Existing log has ${existingLog.uploaded?.length || 0} entries`);

  // Combine existing and new entries
  const allEntries = [
    ...(existingLog.uploaded || []),
    ...(newLog.uploaded || [])
  ];
  console.log(`[DEBUG] Combined ${allEntries.length} total entries for deduplication`);

  // Deduplicate using the same logic as compactUploadLog
  const latestByMessageId = new Map();
  for (const entry of allEntries) {
    if (!entry?.messageId) {
      console.log(`[DEBUG] Skipping entry without messageId:`, entry);
      continue;
    }

    const existing = latestByMessageId.get(entry.messageId);
    if (!existing) {
      latestByMessageId.set(entry.messageId, entry);
      continue;
    }

    if (existing.error && !entry.error) {
      latestByMessageId.set(entry.messageId, entry);
      continue;
    }

    if (existing.error === Boolean(entry.error)) {
      const existingTime = Date.parse(existing.uploadedAt || 0);
      const nextTime = Date.parse(entry.uploadedAt || 0);
      if (nextTime >= existingTime) {
        latestByMessageId.set(entry.messageId, entry);
      }
    }
  }

  const compactedLog = {
    uploaded: [...latestByMessageId.values()].sort(
      (left, right) => Date.parse(left.uploadedAt || 0) - Date.parse(right.uploadedAt || 0)
    ),
  };

  console.log(`[DEBUG] After deduplication: ${compactedLog.uploaded.length} entries`);
  // Save the compacted log
  fs.writeFileSync(UPLOAD_LOG, JSON.stringify(compactedLog, null, 2));
  console.log(`[DEBUG] Upload log saved to ${UPLOAD_LOG}`);
}

function loadMetadata() {
  if (fs.existsSync(METADATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
    return {
      videos: Array.isArray(parsed.videos) ? parsed.videos : [],
      timestamp: parsed.timestamp || null,
    };
  }
  return { videos: [] };
}

function saveMetadata(metadata) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

function getSuccessfulUploadIds(log = loadUploadLog()) {
  return new Set(
    (log.uploaded || [])
      .filter((entry) => entry?.messageId && !entry.error)
      .map((entry) => entry.messageId)
  );
}

function compactUploadLog(log = loadUploadLog()) {
  // Since we now maintain a single deduplicated file, this function
  // just returns the log as-is (it's already compacted)
  return log;
}


function pruneMetadataVideos(videos, successfulUploadIds = getSuccessfulUploadIds()) {
  return (videos || []).filter((video) => {
    if (!video?.messageId) {
      return false;
    }

    if (successfulUploadIds.has(video.messageId)) {
      return false;
    }

    return Boolean(video.filepath && fs.existsSync(video.filepath));
  });
}

function syncPersistentState() {
  const compactedLog = compactUploadLog();
  saveUploadLog(compactedLog);

  const metadata = loadMetadata();
  const successfulUploadIds = getSuccessfulUploadIds(compactedLog);
  saveMetadata({
    videos: pruneMetadataVideos(metadata.videos, successfulUploadIds),
    timestamp: new Date().toISOString(),
  });

  return {
    uploadLog: compactedLog,
    successfulUploadIds,
  };
}

function loadDownloadedMessageIds() {
  const metadata = loadMetadata();
  const ids = new Set();
  const loggedMessageIds = getAllLoggedMessageIds();

  for (const video of metadata.videos || []) {
    if (video?.messageId && (loggedMessageIds.has(video.messageId) || fs.existsSync(video.filepath))) {
      ids.add(video.messageId);
    }
  }

  for (const messageId of loggedMessageIds) {
    ids.add(messageId);
  }

  return ids;
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

function filterAlreadyUploadedVideos(videos) {
  const successfulUploadIds = getSuccessfulUploadIds();

  return videos.filter((video) => !successfulUploadIds.has(video.messageId));
}

function buildUploadTitle(video) {
  const rawTitle = path.parse(video.filename || '').name.trim() || 'whatsapp_video';

  if (rawTitle.length <= 100) {
    return rawTitle;
  }

  return `${rawTitle.slice(0, 97).trimEnd()}...`;
}

function buildUploadDescription(video) {
  return `Video from WhatsApp chat: ${video.chatName}\nDate: ${new Date(video.timestamp * 1000).toISOString()}\n${video.caption || ''}`;
}

function buildVideoFilename(chatName, timestamp, messageId, extension) {
  const dateStr = new Date(timestamp * 1000).toISOString().replace(/[:.]/g, '-');
  const suffix = messageId ? `_${messageId}` : '';
  return `${sanitizeFilename(chatName)}_${dateStr}${suffix}${extension}`;
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
  const oauth2Client = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    redirectUri,
  );

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
  const mediaBody = await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(video.filepath);
    stream.once('open', () => resolve(stream));
    stream.once('error', reject);
  });
  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: mediaBody,
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

function getVideoExtension(msg) {
  const mime = msg.mimetype || '';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('3gp')) return '.3gp';
  if (mime.includes('avi')) return '.avi';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('mkv')) return '.mkv';
  return '.mp4'; // default
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

function levenshteinDistance(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () => []);
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function matchesSearch(target, candidate) {
  const normalizedTarget = normalizeSearchString(target);
  const normalizedCandidate = normalizeSearchString(candidate);
  if (!normalizedTarget || !normalizedCandidate) {
    return false;
  }
  if (
    normalizedTarget === normalizedCandidate ||
    normalizedTarget.includes(normalizedCandidate) ||
    normalizedCandidate.includes(normalizedTarget)
  ) {
    return true;
  }

  const distance = levenshteinDistance(normalizedTarget, normalizedCandidate);
  const maxDistance = Math.max(1, Math.floor(Math.min(normalizedTarget.length, normalizedCandidate.length) * 0.15));
  return distance <= maxDistance;
}

function getTimestampValue(timestamp) {
  if (typeof timestamp === 'object' && timestamp !== null && 'low' in timestamp) {
    return timestamp.low;
  }
  return Number(timestamp || 0);
}

function getTimestampMilliseconds(timestamp) {
  const value = getTimestampValue(timestamp);
  if (value === 0) {
    return 0;
  }
  return value < 1e12 ? value * 1000 : value;
}

function unwrapMessageContent(message) {
  if (!message) {
    return null;
  }

  if (message.ephemeralMessage?.message) {
    return unwrapMessageContent(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessageContent(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessageContent(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessageContent(message.viewOnceMessageV2Extension.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessageContent(message.documentWithCaptionMessage.message);
  }

  return message;
}

function summarizeHistoryBatch(messages, targetChatId) {
  const totalMessages = messages.length;
  const targetMessages = messages.filter((msg) => msg?.key?.remoteJid === targetChatId).length;
  const videoMessages = messages.filter((msg) => collectVideoMessage(msg)).length;
  const targetVideoMessages = messages.filter((msg) => msg?.key?.remoteJid === targetChatId && collectVideoMessage(msg)).length;

  return {
    totalMessages,
    targetMessages,
    videoMessages,
    targetVideoMessages,
  };
}

function addMessagesToCache(messageCache, messages) {
  for (const message of messages || []) {
    const jid = message?.key?.remoteJid;
    const id = message?.key?.id;
    if (!jid || !id) {
      continue;
    }

    const existing = messageCache.get(jid) || [];
    if (existing.some((entry) => entry?.key?.id === id)) {
      continue;
    }

    existing.push(message);
    existing.sort((left, right) => getTimestampValue(left.messageTimestamp) - getTimestampValue(right.messageTimestamp));
    messageCache.set(jid, existing);
  }
}

function collectVideoMessage(msg) {
  const content = unwrapMessageContent(msg?.message);
  if (!content) {
    return null;
  }

  if (content.videoMessage) {
    return content.videoMessage;
  }

  if (content.documentMessage?.mimetype?.startsWith('video/')) {
    return content.documentMessage;
  }

  return null;
}

function summarizeVideoMessage(videoMsg) {
  if (!videoMsg) {
    return {};
  }

  return {
    mimetype: videoMsg.mimetype || null,
    fileLength: videoMsg.fileLength || null,
    seconds: videoMsg.seconds || null,
    mediaKeyTimestamp: videoMsg.mediaKeyTimestamp || null,
    directPath: videoMsg.directPath || null,
    url: videoMsg.url || null,
    hasMediaKey: Boolean(videoMsg.mediaKey),
    hasFileEncSha256: Boolean(videoMsg.fileEncSha256),
    hasFileSha256: Boolean(videoMsg.fileSha256),
  };
}

function summarizeDownloadError(err) {
  if (!err) {
    return { message: 'Unknown error' };
  }

  return {
    name: err.name || null,
    message: err.message || String(err),
    stack: err.stack || null,
    statusCode: err.output?.statusCode || err.statusCode || null,
    data: err.data || null,
    cause: err.cause
      ? {
          name: err.cause.name || null,
          message: err.cause.message || String(err.cause),
          statusCode: err.cause.output?.statusCode || err.cause.statusCode || null,
        }
      : null,
  };
}

function summarizeMessage(msg) {
  return {
    id: msg?.key?.id || null,
    remoteJid: msg?.key?.remoteJid || null,
    participant: msg?.key?.participant || null,
    fromMe: msg?.key?.fromMe || false,
    timestamp: getTimestampValue(msg?.messageTimestamp),
    hasMessage: Boolean(msg?.message),
    messageKeys: msg?.message ? Object.keys(msg.message) : [],
  };
}

function createDebugFiles(chatId) {
  const debugBaseName = sanitizeDebugName(chatId);
  return {
    upsert: path.join(DEBUG_DIR, `${debugBaseName}.messages_upsert.jsonl`),
    history: path.join(DEBUG_DIR, `${debugBaseName}.messaging_history_set.jsonl`),
    connection: path.join(DEBUG_DIR, `${debugBaseName}.connection_update.jsonl`),
  };
}

function findOfflineHistoryFiles() {
  const debugDir = path.join(process.cwd(), 'watch_debug');
  if (!fs.existsSync(debugDir)) {
    return [];
  }

  return fs.readdirSync(debugDir)
    .filter((name) => name.endsWith('.messaging_history_set.jsonl') || name.endsWith('.messages_upsert.jsonl'))
    .map((name) => path.join(debugDir, name));
}

function isFreshNonEmptyFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= 0) {
      return false;
    }
    return (Date.now() - stats.mtimeMs) <= HISTORY_CACHE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function hasCachedHistory(chatId, chatName) {
  if (FORCE_CAPTURE) {
    return false;
  }

  // Check for new chatId-based file
  const directHistoryFile = createDebugFiles(chatId).history;

  if (isFreshNonEmptyFile(directHistoryFile)) {
    return true;
  }

  // Also check for old chatName-based file
  const oldHistoryFile = path.join(DEBUG_DIR, `${sanitizeDebugName(chatName)}.messaging_history_set.jsonl`);
  if (isFreshNonEmptyFile(oldHistoryFile)) {
    return true;
  }

  const debugDir = path.join(process.cwd(), 'watch_debug');
  if (!fs.existsSync(debugDir)) {
    return false;
  }

  return fs.readdirSync(debugDir)
    .filter((name) => name.endsWith('.messaging_history_set.jsonl'))
    .some((name) => {
      const filePath = path.join(debugDir, name);
      try {
        if (!isFreshNonEmptyFile(filePath)) {
          return false;
        }
        return fs.readFileSync(filePath, 'utf8').includes(`"remoteJid":"${chatId}"`);
      } catch {
        return false;
      }
    });
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
  const historyFiles = findOfflineHistoryFiles();
  const messages = [];
  const seenIds = new Set();

  // Look for files that match either chatId or sanitized chatName
  const chatIdPattern = sanitizeDebugName(chatId);
  const chatNamePattern = sanitizeDebugName(chatName);

  for (const filePath of historyFiles) {
    const filename = path.basename(filePath, path.extname(filePath));
    // Check if this file is for our chat (either by ID or name)
    if (!filename.startsWith(chatIdPattern) && !filename.startsWith(chatNamePattern)) {
      continue;
    }

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const candidates = extractMessagesFromHistoryEntry(parsed);
        for (const msg of candidates) {
          const remoteJid = msg?.key?.remoteJid;
          const id = msg?.key?.id;
          if (remoteJid !== chatId || !id || seenIds.has(id)) {
            continue;
          }
          seenIds.add(id);
          messages.push(msg);
        }
      } catch (err) {
        console.log(`[WARN] Could not parse offline history line from ${path.basename(filePath)}: ${err.message}`);
      }
    }
  }

  messages.sort((left, right) => getTimestampValue(left.messageTimestamp) - getTimestampValue(right.messageTimestamp));
  return messages;
}

async function requestChatHistory(sock, chatId, referenceMessage, messageCache) {
  if (!sock?.fetchMessageHistory || !referenceMessage?.key) {
    return false;
  }

  const oldestMsgKey = referenceMessage.key;
  const oldestMsgTimestamp = getTimestampMilliseconds(referenceMessage.messageTimestamp);
  if (!oldestMsgKey.remoteJid || oldestMsgKey.remoteJid !== chatId || !oldestMsgKey.id) {
    return false;
  }

  try {
    console.log(`[INFO] Requesting on-demand history for "${chatId}" from message ${oldestMsgKey.id} (timestamp: ${oldestMsgTimestamp})`);
    const result = await sock.fetchMessageHistory(100, oldestMsgKey, oldestMsgTimestamp);
    console.log(`[INFO] History request completed for "${chatId}", result:`, result);

    // fetchMessageHistory returns a cursor, not messages directly
    // Messages will come through messaging-history.set event
    // Let's also try to force a sync for this chat
    if (sock.store) {
      console.log(`[INFO] Store methods available:`, Object.getOwnPropertyNames(Object.getPrototypeOf(sock.store)).filter(m => typeof sock.store[m] === 'function'));
      if (typeof sock.store.sync === 'function') {
        console.log(`[INFO] Attempting manual sync for "${chatId}"`);
        try {
          await sock.store.sync([chatId]);
          console.log(`[INFO] Manual sync completed for "${chatId}"`);
        } catch (err) {
          console.warn(`[WARN] Manual sync failed for "${chatId}": ${err.message}`);
        }
      }

      // Check if messages are available in store after sync
      if (sock.store.messages && sock.store.messages[chatId]) {
        const storeMsgs = sock.store.messages[chatId];
        console.log(`[INFO] Found ${storeMsgs.length} messages in store for "${chatId}"`);
        if (storeMsgs.length > 0) {
          addMessagesToCache(messageCache, storeMsgs);
          console.log(`[INFO] Added store messages to cache for "${chatId}"`);
        }
      }
    }

    // Also try to trigger a manual sync for this chat
    if (sock.store && typeof sock.store.loadMessages === 'function') {
      console.log(`[INFO] Attempting manual message load for "${chatId}"`);
      const storeMessages = await sock.store.loadMessages(chatId, 100);
      if (Array.isArray(storeMessages) && storeMessages.length > 0) {
        console.log(`[INFO] Processing ${storeMessages.length} messages from store load for "${chatId}"`);
        console.log(`[DEBUG] Store sample message keys:`, storeMessages.slice(0, 3).map(m => m?.key?.id));
        addMessagesToCache(messageCache, storeMessages);
        console.log(`[INFO] Cache now has ${messageCache.get(chatId)?.length || 0} messages for "${chatId}" after store load`);
      }
    }

    return true;
  } catch (err) {
    console.warn(`[WARN] Could not request history for "${chatId}": ${err.message}`);
    return false;
  }
}

function buildVideoRecordFromMessage(chatId, chatName, msg) {
  const videoMsg = collectVideoMessage(msg);
  if (!videoMsg || !msg?.key?.id) {
    return null;
  }

  const timestamp = getTimestampValue(msg.messageTimestamp);
  const filename = buildVideoFilename(chatName, timestamp, msg.key.id, getVideoExtension(videoMsg));
  const filepath = path.join(DOWNLOAD_DIR, sanitizeFilename(chatId), filename);

  return {
    filepath,
    filename,
    chatName,
    chatId,
    timestamp,
    caption: videoMsg.caption || '',
    mimetype: videoMsg.mimetype,
    size: videoMsg.fileLength,
    messageId: msg.key.id,
  };
}

function loadUploadCandidatesFromDisk(chatId, chatName) {
  const metadata = loadMetadata();
  const successfulUploadIds = getSuccessfulUploadIds();

  return (metadata.videos || [])
    .filter((video) => video?.chatId === chatId)
    .filter((video) => !successfulUploadIds.has(video?.messageId))
    .filter((video) => video?.filepath && fs.existsSync(video.filepath))
    .filter((video) => typeof video?.mimetype === 'string' && video.mimetype.startsWith('video/'))
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
}

// ============ WHATSAPP CONNECTION ============
async function connectWhatsApp() {
  console.log('[INFO] Connecting to WhatsApp using auth state...');
  
  if (!fs.existsSync(AUTH_FOLDER)) {
    console.error(`[ERROR] Auth folder not found: ${AUTH_FOLDER}`);
    console.error('[ERROR] Please run "node whatsapp_login.mjs" first to authenticate.');
    process.exit(1);
  }
  
  // Check if auth folder has credentials
  const credsFile = path.join(AUTH_FOLDER, 'app-state-json.json');
  const baileysCreds = path.join(AUTH_FOLDER, 'creds.json');
  if (!fs.existsSync(credsFile) && !fs.existsSync(baileysCreds)) {
    console.error(`[ERROR] No auth credentials found in: ${AUTH_FOLDER}`);
    console.error('[ERROR] Please run "node whatsapp_login.mjs" first to authenticate.');
    process.exit(1);
  }

  const { version } = await fetchLatestBaileysVersion();
  console.log(`[INFO] Using Baileys version: ${version.join('.')}`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

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
    downloadHistory: true,
  });

  sock.ev.on('creds.update', saveCreds);

  return new Promise((resolve, reject) => {
    let opened = false;

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        opened = true;
        console.log('[SUCCESS] Connected to WhatsApp!');
        resolve(sock);
        return;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          reject(new Error('Logged out from WhatsApp'));
          return;
        }

        if (!opened) {
          reject(new Error(`Connection closed before opening (${statusCode || 'unknown'})`));
          return;
        }

        console.log(`[WARN] Connection dropped after opening (${statusCode || 'unknown'}).`);
      }
    });
  });
}

async function captureHistoryMetadata(sock, chatId, chatName) {
  console.log(`[DEBUG] Starting history capture for chat "${chatName}" (${chatId})`);
  const debugFiles = createDebugFiles(chatId);
  console.log(`[DEBUG] Debug files:`, debugFiles);
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
        `[DEBUG] Global event summary for "${chatName}": historyEvents=${globalHistoryEventCount}, historyMessages=${globalHistoryMessageCount}, upsertEvents=${globalUpsertEventCount}, upsertMessages=${globalUpsertMessageCount}, targetMessages=${capturedMessages.length}`
      );
      console.log(`[DEBUG] Seen history JIDs for "${chatName}": ${summarizeSeenJids(seenHistoryJids)}`);
      console.log(`[DEBUG] Seen upsert JIDs for "${chatName}": ${summarizeSeenJids(seenUpsertJids)}`);
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
      console.log(`[DEBUG] History capture finished for "${chatName}". Captured ${capturedMessages.length} messages.`);
      resolve(capturedMessages);
    };

    const historyHandler = ({ chats, contacts, messages, isLatest, progress, syncType }) => {
      console.log(`[DEBUG] Received messaging-history.set event for "${chatName}": chats=${chats?.length || 0}, contacts=${contacts?.length || 0}, messages=${messages?.length || 0}, isLatest=${Boolean(isLatest)}, progress=${progress}, syncType=${syncType}`);

      globalHistoryEventCount += 1;
      globalHistoryMessageCount += messages?.length || 0;
      collectSeenJids(messages, seenHistoryJids);

      const targetMessages = (messages || []).filter((msg) => msg?.key?.remoteJid === chatId);

      appendDebugJson(debugFiles.history, {
        at: new Date().toISOString(),
        chats: chats || [],
        contacts: contacts || [],
        messages: targetMessages,
        isLatest: Boolean(isLatest),
        progress: progress ?? null,
        syncType: syncType ?? null,
      });

      const batch = messages || [];
      const summary = summarizeHistoryBatch(batch, chatId);
      console.log(
        `[CAPTURE] ${chatName} progress=${progress ?? 'n/a'} syncType=${syncType ?? 'n/a'} isLatest=${Boolean(isLatest)} total=${summary.totalMessages} target=${summary.targetMessages} videos=${summary.videoMessages} targetVideos=${summary.targetVideoMessages}`
      );

      if (summary.targetMessages > 0) {
        console.log(`[DEBUG] Sample target messages for "${chatName}":`, batch.filter((msg) => msg?.key?.remoteJid === chatId).slice(0, 3).map(summarizeMessage));
      }

      if (isLatest) {
        console.log(`[DEBUG] History sync marked as latest for "${chatName}"`);
        finish();
      }
    };

    const upsertHandler = ({ messages, type }) => {
      console.log(`[DEBUG] Received messages.upsert event for "${chatName}": type=${type}, messages=${messages?.length || 0}`);

      globalUpsertEventCount += 1;
      globalUpsertMessageCount += messages?.length || 0;
      collectSeenJids(messages, seenUpsertJids);

      const targetMessages = (messages || []).filter((msg) => msg?.key?.remoteJid === chatId);

      appendDebugJson(debugFiles.upsert, {
        at: new Date().toISOString(),
        type: type || null,
        messages: targetMessages,
      });
      capturedMessages.push(...targetMessages);
    };

    const connectionHandler = ({ connection, lastDisconnect }) => {
      console.log(`[DEBUG] Connection update for "${chatName}": connection=${connection}, statusCode=${lastDisconnect?.error?.output?.statusCode || null}`);

      appendDebugJson(debugFiles.connection, {
        at: new Date().toISOString(),
        connection: connection || null,
        statusCode: lastDisconnect?.error?.output?.statusCode || null,
      });
    };

    sock.ev.on('messaging-history.set', historyHandler);
    sock.ev.on('messages.upsert', upsertHandler);
    sock.ev.on('connection.update', connectionHandler);

    console.log(`[INFO] Capturing history metadata for "${chatName}" into ${debugFiles.history}`);
    finishTimer = setTimeout(() => {
      console.log(`[DEBUG] History capture timeout triggered for "${chatName}" after ${HISTORY_WAIT_MS}ms`);
      console.log(`[WARN] Metadata capture timeout reached for "${chatName}" after ${HISTORY_WAIT_MS}ms.`);
      finish();
    }, HISTORY_WAIT_MS);
  });
}

// ============ CHAT DISCOVERY ============
async function findChatJids(sock, targetNames) {
  console.log('[DEBUG] Starting chat discovery for targets:', targetNames);

  const chatMap = {};

  for (const target of targetNames) {
    if (target.includes('@')) {
      chatMap[target] = { id: target, name: target, isGroup: target.endsWith('@g.us') };
      console.log(`[DEBUG] Using direct chat JID: "${target}" (isGroup: ${target.endsWith('@g.us')})`);
    }
  }

  // First, try groups
  try {
    console.log('[DEBUG] Fetching all participating groups...');
    const groups = normalizeGroups(await sock.groupFetchAllParticipating());
    console.log(`[DEBUG] Found ${groups.length} groups total`);

    for (const chat of groups) {
      const name = chat.subject || chat.id;
      console.log(`[DEBUG] Checking group: "${name}" (ID: ${chat.id})`);

      for (const target of targetNames) {
        if (chatMap[target]) {
          console.log(`[DEBUG] Target "${target}" already resolved, skipping`);
          continue;
        }
        if (matchesSearch(target, name)) {
          chatMap[target] = { id: chat.id, name: chat.subject || chat.id, isGroup: true };
          console.log(`[DEBUG] Matched group "${chat.subject || chat.id}" -> ${chat.id} for target "${target}"`);
        }
      }
    }
  } catch (err) {
    console.log('[DEBUG] Group fetch error details:', err);
    console.log('[WARN] Could not fetch groups:', err.message);
  }

  // For targets not found in groups, try to find in contacts/chats
  for (const target of targetNames) {
    if (!chatMap[target]) {
      console.log(`[DEBUG] "${target}" not found in groups. Searching in contacts and chat store...`);
      try {
        const contacts = await sock.store?.contacts;
        console.log(`[DEBUG] Checking ${Object.keys(contacts || {}).length} contacts`);

        if (contacts) {
          for (const [jid, contact] of Object.entries(contacts)) {
            const contactName = contact.name || contact.notify || '';
            console.log(`[DEBUG] Checking contact "${contactName}" (JID: ${jid}) against target "${target}"`);

            if (matchesSearch(target, contactName)) {
              chatMap[target] = { id: jid, name: contactName, isGroup: false };
              console.log(`[DEBUG] Found contact match: "${contactName}" -> ${jid} for target "${target}"`);
              break;
            }
          }
        }
      } catch (err) {
        console.log(`[DEBUG] Contact search error for "${target}":`, err);
        console.log(`[WARN] Could not search contacts for "${target}": ${err.message}`);
      }

      if (!chatMap[target]) {
        try {
          const chats = await sock.store?.chats;
          console.log(`[DEBUG] Checking ${Object.keys(chats || {}).length} chats in store`);

          if (chats) {
            for (const [jid, chat] of Object.entries(chats)) {
              const chatName = chat.name || chat.subject || '';
              if (!chatName) {
                console.log(`[DEBUG] Skipping chat ${jid} - no name`);
                continue;
              }
              console.log(`[DEBUG] Checking chat "${chatName}" (JID: ${jid}) against target "${target}"`);

              if (matchesSearch(target, chatName)) {
                chatMap[target] = { id: jid, name: chatName, isGroup: jid.endsWith('@g.us') };
                console.log(`[DEBUG] Found chat store match: "${chatName}" -> ${jid} for target "${target}"`);
                break;
              }
            }
          }
        } catch (err) {
          console.log(`[DEBUG] Chat store search error for "${target}":`, err);
          console.log(`[WARN] Could not search chat store for "${target}": ${err.message}`);
        }
      }

      if (!chatMap[target]) {
        console.log(`[DEBUG] Target "${target}" not found anywhere`);
        console.log(`[WARN] Chat "${target}" not found. It may appear after history sync completes.`);
      }
    }
  }

  console.log('[DEBUG] Final chat map:', chatMap);
  return chatMap;
}

function logResolvedChats(chatMap) {
  const entries = Object.entries(chatMap);
  if (entries.length === 0) {
    console.log('[WARN] No chats were resolved.');
    return;
  }

  console.log('[INFO] Resolved chats:');
  for (const [target, chat] of entries) {
    console.log(`  - ${target} -> ${chat.id} (${chat.name || 'unknown'})`);
  }
}

// ============ VIDEO DOWNLOAD ============
async function downloadVideosFromChat(sock, chatId, chatName, downloadedMessageIds, initialMessages = []) {
  console.log(`[DEBUG] Starting video download for chat "${chatName}" (${chatId})`);
  console.log(`[DEBUG] Already downloaded message IDs: ${downloadedMessageIds.size}`);
  console.log(`[DEBUG] Initial messages provided: ${initialMessages.length}`);

  ensureDir(DOWNLOAD_DIR);

  const chatDir = path.join(DOWNLOAD_DIR, sanitizeFilename(chatId));
  console.log(`[DEBUG] Chat directory: ${chatDir}`);
  ensureDir(chatDir);

  const videos = [];
  const seenMessageIds = new Set();
  const messageCache = new Map();

  if (initialMessages && initialMessages.length > 0) {
    addMessagesToCache(messageCache, initialMessages);
    console.log(`[INFO] Preloaded ${initialMessages.length} captured messages for "${chatName}" before download.`);
  }

  const offlineMessages = loadOfflineMessagesForChat(chatId, chatName);
  console.log(`[DEBUG] Loaded ${offlineMessages.length} offline messages from debug files`);
  if (offlineMessages.length > 0) {
    addMessagesToCache(messageCache, offlineMessages);
    console.log(`[INFO] Preloaded ${offlineMessages.length} offline debug messages for "${chatName}" before download.`);
  }

  const existingMessages = messageCache.get(chatId) || [];
  console.log(`[DEBUG] Total cached messages for chat: ${existingMessages.length}`);
  
  return new Promise((resolve) => {
    let finished = false;
    let finishTimer = null;

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
      const cachedMessages = messageCache.get(chatId) || [];
      processMessages(cachedMessages).finally(async () => {
        console.log(`[INFO] Cached ${cachedMessages.length} messages for "${chatName}" before final processing`);

        if (seenMessageIds.size === 0) {
          const offlineMessages = loadOfflineMessagesForChat(chatId, chatName);
          if (offlineMessages.length > 0) {
            console.log(`[INFO] Falling back to ${offlineMessages.length} offline messages from watch_debug for "${chatName}".`);
            await processMessages(offlineMessages);
          }
        }

        console.log(`[INFO] Processed ${seenMessageIds.size} messages from "${chatName}", found ${videos.length} videos`);
        if (seenMessageIds.size === 0) {
          console.log(`[WARN] No local or offline history is available yet for "${chatName}".`);
        }
        resolve(videos);
      });
    };

    const processMessages = async (messages) => {
      console.log(`[DEBUG] Processing ${messages.length} messages for "${chatName}"`);

      for (const msg of messages) {
        if (!msg?.key?.id) {
          console.log(`[DEBUG] Skipping message without ID`);
          continue;
        }

        if (msg.key.remoteJid !== chatId) {
          console.log(`[DEBUG] Skipping message ${msg.key.id} - wrong chat (${msg.key.remoteJid} != ${chatId})`);
          continue;
        }

        if (seenMessageIds.has(msg.key.id)) {
          console.log(`[DEBUG] Skipping already seen message ${msg.key.id}`);
          continue;
        }

        seenMessageIds.add(msg.key.id);
        const content = unwrapMessageContent(msg.message);
        const messageKeys = content ? Object.keys(content).join(',') : 'none';
        console.log(`[TARGET] ${chatName} message ${msg.key.id} keys=${messageKeys}`);

        const videoMsg = collectVideoMessage(msg);

        if (videoMsg) {
          console.log(`[DEBUG] Found video message ${msg.key.id}`);

          if (downloadedMessageIds.has(msg.key.id)) {
            console.log(`[SKIP] Already downloaded message ${msg.key.id} from "${chatName}"`);
            continue;
          }

          const timestamp = getTimestampValue(msg.messageTimestamp);
          const filename = buildVideoFilename(chatName, timestamp, msg.key.id, getVideoExtension(videoMsg));
          const filepath = path.join(chatDir, filename);
          const sender = msg.key.participant || msg.pushName || 'unknown';

          console.log(`[INFO] Found video: ${filename} (${(videoMsg.fileLength / 1024 / 1024).toFixed(1)} MB)`);
          console.log(`[DEBUG] Video message ${msg.key.id} sender=${sender}`);
          console.log(`[DEBUG] Video metadata ${JSON.stringify(summarizeVideoMessage(videoMsg))}`);
          console.log(`[DEBUG] Video will be saved to: ${filepath}`);

          if (!DRY_RUN) {
            try {
              console.log(`[INFO] Downloading: ${filename}...`);
              const buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                { logger: P({ level: 'silent' }) }
              );

              fs.writeFileSync(filepath, buffer);
              console.log(`[SUCCESS] Downloaded: ${filename}`);

              videos.push({
                filepath,
                filename,
                chatName,
                chatId,
                timestamp,
                caption: videoMsg.caption || '',
                mimetype: videoMsg.mimetype,
                size: videoMsg.fileLength,
                messageId: msg.key.id,
              });
              downloadedMessageIds.add(msg.key.id);
            } catch (err) {
              console.error(`[ERROR] Failed to download ${filename}: ${err.message}`);
              console.error(`[ERROR] Download failure details ${JSON.stringify(summarizeDownloadError(err))}`);
            }
          } else {
            console.log(`[DRY-RUN] Would download: ${filename}`);
            videos.push({
              filepath,
              filename,
              chatName,
              chatId,
              timestamp,
              caption: videoMsg.caption || '',
              mimetype: videoMsg.mimetype,
              size: videoMsg.fileLength,
              messageId: msg.key.id,
            });
            downloadedMessageIds.add(msg.key.id);
          }
        } else {
          console.log(`[DEBUG] Message ${msg.key.id} is not a video (keys: ${messageKeys})`);
        }
      }
    };

    const historyHandler = async ({ messages, isLatest, progress, syncType }) => {
      console.log(`[DEBUG] Received messaging-history.set during download for "${chatName}": messages=${messages?.length || 0}, isLatest=${Boolean(isLatest)}, progress=${progress}, syncType=${syncType}`);

      const batch = messages || [];
      addMessagesToCache(messageCache, batch);
      const summary = summarizeHistoryBatch(batch, chatId);
      console.log(
        `[SYNC] ${chatName} progress=${progress ?? 'n/a'} syncType=${syncType ?? 'n/a'} isLatest=${Boolean(isLatest)} total=${summary.totalMessages} target=${summary.targetMessages} videos=${summary.videoMessages} targetVideos=${summary.targetVideoMessages}`
      );

      if (isLatest) {
        console.log(`[DEBUG] History sync reached latest state for "${chatName}" during download`);
        console.log(`[INFO] History sync reached latest state for "${chatName}".`);
        finish();
      }
    };

    const upsertHandler = async ({ messages }) => {
      console.log(`[DEBUG] Received messages.upsert during download for "${chatName}": messages=${messages?.length || 0}`);
      addMessagesToCache(messageCache, messages || []);
    };

    sock.ev.on('messaging-history.set', historyHandler);
    sock.ev.on('messages.upsert', upsertHandler);

    const existingMessages = messageCache.get(chatId) || [];
    if (existingMessages.length > 0) {
      // Try requesting history from multiple reference points
      const oldestMessage = existingMessages[0];
      requestChatHistory(sock, chatId, oldestMessage, messageCache).catch((err) => {
        console.warn(`[WARN] Failed to request history from oldest message: ${err.message}`);
      });

      // Also try requesting from 3 days ago as fallback
      const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
      const syntheticOldMessage = {
        key: {
          remoteJid: chatId,
          id: 'synthetic_old_message',
          fromMe: false
        },
        messageTimestamp: Math.floor(threeDaysAgo / 1000)
      };
      requestChatHistory(sock, chatId, syntheticOldMessage, messageCache).catch((err) => {
        console.warn(`[WARN] Failed to request history from 3 days ago: ${err.message}`);
      });
    }
    
    console.log(`[INFO] Waiting up to ${HISTORY_WAIT_MS}ms for synced history for "${chatName}"...`);
    finishTimer = setTimeout(() => {
      console.log(`[WARN] History sync timeout reached for "${chatName}" after ${HISTORY_WAIT_MS}ms.`);
      finish();
    }, HISTORY_WAIT_MS);
  });
}

// ============ YOUTUBE UPLOAD ============
async function uploadToYouTube(videos) {
  const state = syncPersistentState();
  const log = state.uploadLog;
  const auth = DRY_RUN ? null : await getYouTubeAuthClient();
  
  for (const video of videos) {
    // Skip already uploaded
    if (log.uploaded.find(u => u.messageId === video.messageId && !u.error)) {
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
    console.log(`[INFO]   Title: ${title}`);
    console.log('[INFO]   Privacy: public');
    
    if (!DRY_RUN) {
      try {
        const output = await uploadVideoWithOAuth(auth, video, title, description);
        console.log(`[SUCCESS] Uploaded: ${video.filename}`);
        console.log(JSON.stringify(output, null, 2));
        
        log.uploaded.push({
          messageId: video.messageId,
          filename: video.filename,
          title,
          uploadedAt: new Date().toISOString(),
          videoId: output.videoId,
          url: output.url,
        });
        saveUploadLog(log);
        
        // Clean up downloaded file after successful upload
        try {
          fs.unlinkSync(video.filepath);
          console.log(`[INFO] Cleaned up: ${video.filepath}`);
        } catch (e) { /* ignore */ }

        const metadata = loadMetadata();
        saveMetadata({
          videos: pruneMetadataVideos(
            metadata.videos.filter((entry) => entry?.messageId !== video.messageId),
            getSuccessfulUploadIds(log)
          ),
          timestamp: new Date().toISOString(),
        });
        
      } catch (err) {
        console.error(`[ERROR] Failed to upload ${video.filename}: ${err.message}`);
        log.uploaded.push({
          messageId: video.messageId,
          filename: video.filename,
          title,
          uploadedAt: new Date().toISOString(),
          error: err.message,
        });
        saveUploadLog(log);
      }
    } else {
      console.log(`[DRY-RUN] Would upload: ${video.filename} with title "${title}"`);
    }
  }
}

// ============ MAIN ============
async function main() {
  console.log(`[DEBUG] Starting main function with args: ${JSON.stringify(process.argv.slice(2))}`);
  console.log(`[DEBUG] Environment: DRY_RUN=${DRY_RUN}, DOWNLOAD_ONLY=${DOWNLOAD_ONLY}, CAPTURE_ONLY=${CAPTURE_ONLY}, UPLOAD_ONLY=${UPLOAD_ONLY}`);
  console.log('========================================');
  console.log('WhatsApp Video Downloader + YouTube Uploader');
  console.log('========================================');
  console.log(`[CONFIG] Target chats: ${TARGET_CHATS.join(', ')}`);
  console.log(`[CONFIG] Target chat JIDs: ${TARGET_CHAT_JIDS.length ? TARGET_CHAT_JIDS.join(', ') : '(none)'}`);
  console.log(`[CONFIG] Download dir: ${DOWNLOAD_DIR}`);
  console.log(`[CONFIG] OAuth client secrets: ${YOUTUBE_CLIENT_SECRETS}`);
  console.log(`[CONFIG] OAuth token file: ${YOUTUBE_TOKEN_FILE}`);
  console.log(`[CONFIG] Auth folder: ${AUTH_FOLDER}`);
  console.log(`[CONFIG] Dry run: ${DRY_RUN}`);
  console.log('========================================');

  ensureDir(DOWNLOAD_DIR);
  syncPersistentState();

  // Step 1: Connect to WhatsApp
  console.log(`[DEBUG] Connecting to WhatsApp`);
  const sock = await connectWhatsApp();
  console.log(`[DEBUG] WhatsApp connection established`);
  const downloadedMessageIds = loadDownloadedMessageIds();
  console.log(`[DEBUG] Loaded ${downloadedMessageIds.size} downloaded message IDs`);
  const existingMetadata = loadMetadata();
  console.log(`[DEBUG] Loaded existing metadata with ${existingMetadata.videos?.length || 0} videos`);

  // Step 2: Find target chats
  const requestedTargets = [...TARGET_CHATS, ...TARGET_CHAT_JIDS];
  console.log(`[DEBUG] Finding target chats for:`, requestedTargets);
  const chatMap = await findChatJids(sock, requestedTargets);
  console.log(`[DEBUG] Found ${Object.keys(chatMap).length} target chats`);
  logResolvedChats(chatMap);
  
  // Step 3: Download videos from each chat
  const allVideos = [];
  const uploadCandidates = [];
  console.log(`[DEBUG] Processing ${requestedTargets.length} target chats`);

  for (const target of requestedTargets) {
    console.log(`[DEBUG] Processing target: "${target}"`);
    const chatInfo = chatMap[target];
    if (!chatInfo) {
      console.log(`[WARN] Skipping "${target}" - not found`);
      continue;
    }

    console.log(`[DEBUG] Chat info for "${target}":`, chatInfo);

    let capturedMessages = [];
    if (hasCachedHistory(chatInfo.id, chatInfo.name || target)) {
      console.log(`[INFO] Historic metadata already cached for "${chatInfo.name || target}". Skipping capture.`);
    } else {
      console.log(`[DEBUG] No cached history found, starting capture for "${chatInfo.name || target}"`);
      capturedMessages = await captureHistoryMetadata(sock, chatInfo.id, chatInfo.name || target);
    }

    if (CAPTURE_ONLY) {
      console.log(`[INFO] Capture-only mode enabled. Skipping downloads for "${chatInfo.name || target}".`);
      continue;
    }

    const videos = await downloadVideosFromChat(sock, chatInfo.id, chatInfo.name || target, downloadedMessageIds, capturedMessages || []);
    console.log(`[DEBUG] Downloaded ${videos.length} videos from "${chatInfo.name || target}"`);
    allVideos.push(...videos);
    uploadCandidates.push(...videos);

    if (videos.length === 0 && !DOWNLOAD_ONLY) {
      const recoveredVideos = loadUploadCandidatesFromDisk(chatInfo.id, chatInfo.name || target);
      console.log(`[DEBUG] Recovered ${recoveredVideos.length} local videos from disk for "${chatInfo.name || target}"`);
      if (recoveredVideos.length > 0) {
        console.log(`[INFO] Recovered ${recoveredVideos.length} local video(s) for upload from disk for "${chatInfo.name || target}".`);
        uploadCandidates.push(...recoveredVideos);
      }
    }
  }
  
  // Save metadata
  saveMetadata({
    videos: pruneMetadataVideos(mergeVideosByMessageId(existingMetadata.videos, allVideos)),
    timestamp: new Date().toISOString(),
  });
  
  console.log(`\n[INFO] Total videos found: ${allVideos.length}`);
  console.log(`[DEBUG] Upload candidates: ${uploadCandidates.length}`);

  if (!CAPTURE_ONLY && allVideos.length === 0) {
    console.log('[WARN] No videos found. The chat history may still be syncing.');
    console.log('[WARN] Try running again in a few minutes after history sync completes.');
  }

  // Step 4: Upload to YouTube
  if (CAPTURE_ONLY) {
    console.log('\n[INFO] Capture-only mode. Skipping downloads and YouTube upload.');
    console.log('[INFO] Metadata logs are saved in: ' + DEBUG_DIR);
  } else if (DOWNLOAD_ONLY) {
    console.log('\n[INFO] Download-only mode. Skipping YouTube upload.');
    console.log('[INFO] Videos are saved in: ' + DOWNLOAD_DIR);
  } else if (!DRY_RUN) {
    const videosToUpload = filterAlreadyUploadedVideos(mergeVideosByMessageId(allVideos, uploadCandidates));
    console.log(`[DEBUG] Videos to upload after filtering: ${videosToUpload.length}`);
    await uploadToYouTube(videosToUpload);
  }

  console.log('\n[DONE] Process complete!');
  
  // Keep alive briefly to ensure all downloads finish
  setTimeout(() => process.exit(0), 5000);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

function getAllLoggedMessageIds() {
  const log = loadUploadLog();
  return new Set(
    (log.uploaded || [])
      .map((entry) => entry?.messageId)
      .filter(Boolean)
  );
}
