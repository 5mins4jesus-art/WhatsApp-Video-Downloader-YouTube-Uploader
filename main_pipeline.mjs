#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import path from 'path';
import { google } from 'googleapis';

const workspaceDir = process.cwd();
const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set([
    '--help',
    '-h',
    '--list-messages',
    '--all-history',
    '--today',
    '--day-offset',
    '--last-days',
    '--limit',
    '--chats',
    '--videos-only',
    '--images-only',
    '--download-only',
    '--upload-only',
    '--force-upload',
    '--message-id',
    '--post-only',
    '--include-retry',
    '--skip-auth',
    '--login-if-needed',
    '--verify-youtube',
    '--reupload-missing-youtube',
    '--cleanup-media',
    '--cleanup-only',
    '--cleanup-older-than',
    '--cleanup-dry-run',
    '--no-combine',
    '--combine-only',
    '--combine-date',
    '--combine-chat',
    '--combine-image-seconds',
    '--combine-privacy',
    '--combine-skip-upload',
    '--combine-dry-run',
    '--combine-force',
    '--combine-keep-temp',
    '--combine-keep-output',
    '--combine-no-background-music',
]);

const MEDIA_DIRS = ['downloaded_videos', 'downloaded_images', 'combined_day_videos'];
const MEDIA_EXTENSIONS = new Set([
    '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.3gp',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif',
    '.opus', '.ogg', '.mp3', '.m4a', '.wav', '.aac',
]);

function hasFlag(flag) {
    return args.includes(flag);
}

function getFlagValue(flag, fallback = null) {
    const index = args.indexOf(flag);
    if (index === -1) {
        return fallback;
    }
    return args[index + 1] ?? fallback;
}

function collectFlagValues(flag) {
    const index = args.indexOf(flag);
    if (index === -1) {
        return [];
    }

    const values = [];
    for (let cursor = index + 1; cursor < args.length; cursor += 1) {
        const value = args[cursor];
        if (value.startsWith('--')) {
            break;
        }
        values.push(value);
    }
    return values;
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

function findClosestFlag(flag) {
    const candidates = [...KNOWN_FLAGS]
        .filter((candidate) => candidate.startsWith('--'))
        .map((candidate) => ({
            candidate,
            distance: levenshteinDistance(flag, candidate),
        }))
        .sort((left, right) => left.distance - right.distance);

    return candidates[0] && candidates[0].distance <= 5 ? candidates[0].candidate : null;
}

function validateArgs(argv) {
    const unknownFlags = argv.filter((arg) => arg.startsWith('--') && !KNOWN_FLAGS.has(arg));
    if (!unknownFlags.length) {
        return;
    }

    const messages = unknownFlags.map((flag) => {
        const suggestion = findClosestFlag(flag);
        return suggestion
            ? `${flag} (did you mean ${suggestion}?)`
            : flag;
    });

    throw new Error(`Unknown flag(s): ${messages.join(', ')}`);
}

function printUsage() {
    console.log('Usage: node main_pipeline.mjs [--list-messages] [--all-history] [--today | --day-offset N | --last-days N] [--limit 50] [--chats "Chat1" "Chat2"] [--videos-only] [--images-only] [--download-only] [--upload-only] [--force-upload] [--message-id <whatsapp-message-id>] [--post-only] [--include-retry] [--skip-auth] [--login-if-needed] [--verify-youtube] [--reupload-missing-youtube] [--cleanup-media] [--cleanup-only] [--cleanup-older-than DAYS] [--cleanup-dry-run]');
    console.log('');
    console.log('Runs WhatsApp auth preflight, YouTube auth preflight, video download/upload, image download/queue, image verification, or named WhatsApp history listing in one foreground terminal flow.');
    console.log('');
    console.log('With no options, runs the combine-same-day-media step only (equivalent to --combine-only).');
    console.log('');
    console.log('Cleanup flags:');
    console.log('  --cleanup-media          After the pipeline finishes, delete media files in downloaded_videos/, downloaded_images/, combined_day_videos/ (logs and *.json metadata are preserved).');
    console.log('  --cleanup-only           Skip the pipeline and only run cleanup.');
    console.log('  --cleanup-older-than N   Only remove media files older than N days (default: 0 = all).');
    console.log('  --cleanup-dry-run        List what would be deleted without removing anything.');
    console.log('');
    console.log('Combine step (runs by default after the upload steps):');
    console.log('  --no-combine                  Skip the combine-same-day-media step.');
    console.log('  --combine-only                Skip the rest of the pipeline and only run the combine step.');
    console.log('  --combine-date YYYY-MM-DD     Combine media for a specific Eastern date (otherwise inherits --today/--day-offset/--last-days).');
    console.log('  --combine-chat "Chat Name"    Restrict combine to a single chat.');
    console.log('  --combine-image-seconds N     Per-image segment duration (default 3).');
    console.log('  --combine-privacy V           YouTube privacy: public|unlisted|private (default public).');
    console.log('  --combine-skip-upload         Build combined videos locally without uploading.');
    console.log('  --combine-dry-run             Plan only, do not build or upload.');
    console.log('  --combine-force               Re-build groups even if already uploaded.');
    console.log('  --combine-keep-temp           Preserve ffmpeg scratch directory.');
    console.log('  --combine-keep-output         Keep the combined .mp4 after a successful upload.');
    console.log('  --combine-no-background-music Disable the generated ambient bed.');
}

if (hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    process.exit(0);
}

validateArgs(args);

const allHistory = hasFlag('--all-history');
const listMessages = hasFlag('--list-messages');
const today = hasFlag('--today');
const dayOffset = getFlagValue('--day-offset', null);
const lastDays = getFlagValue('--last-days', null);
const limit = getFlagValue('--limit', '50');
const chats = collectFlagValues('--chats');
const videosOnly = hasFlag('--videos-only');
const imagesOnly = hasFlag('--images-only');
const downloadOnly = hasFlag('--download-only');
const uploadOnly = hasFlag('--upload-only');
const forceUpload = hasFlag('--force-upload');
const messageId = getFlagValue('--message-id', null);
const postOnly = hasFlag('--post-only');
const includeRetry = hasFlag('--include-retry');
const skipAuth = hasFlag('--skip-auth');
const loginIfNeeded = hasFlag('--login-if-needed');
const verifyYouTube = hasFlag('--verify-youtube');
const reuploadMissingYouTube = hasFlag('--reupload-missing-youtube');
const cleanupMedia = hasFlag('--cleanup-media') || hasFlag('--cleanup-only');
const cleanupOnly = hasFlag('--cleanup-only');
const cleanupDryRun = hasFlag('--cleanup-dry-run');
const cleanupOlderThanRaw = getFlagValue('--cleanup-older-than', '0');
const cleanupOlderThanDays = Number.parseFloat(cleanupOlderThanRaw);
if (!Number.isFinite(cleanupOlderThanDays) || cleanupOlderThanDays < 0) {
    console.error('[ERROR] --cleanup-older-than requires a non-negative number of days.');
    process.exit(1);
}

const combineSkip = hasFlag('--no-combine');
const noArgsDefault = args.length === 0;
const combineOnly = hasFlag('--combine-only') || noArgsDefault;
const combineDate = getFlagValue('--combine-date', '') || '';
const combineChat = getFlagValue('--combine-chat', '') || '';
const combineImageSecondsRaw = getFlagValue('--combine-image-seconds', '3');
const combineImageSeconds = Number.parseFloat(combineImageSecondsRaw);
if (!Number.isFinite(combineImageSeconds) || combineImageSeconds <= 0) {
    console.error('[ERROR] --combine-image-seconds requires a positive number.');
    process.exit(1);
}
const combinePrivacy = (getFlagValue('--combine-privacy', 'public') || 'public').trim();
if (!['private', 'unlisted', 'public'].includes(combinePrivacy)) {
    console.error(`[ERROR] Invalid --combine-privacy value: ${combinePrivacy}`);
    process.exit(1);
}
const combineSkipUpload = hasFlag('--combine-skip-upload');
const combineDryRun = hasFlag('--combine-dry-run');
const combineForce = hasFlag('--combine-force');
const combineKeepTemp = hasFlag('--combine-keep-temp');
const combineKeepOutput = hasFlag('--combine-keep-output');
const combineNoBackgroundMusic = hasFlag('--combine-no-background-music');

if (combineSkip && combineOnly) {
    console.error('[ERROR] --no-combine and --combine-only cannot be combined.');
    process.exit(1);
}
const postLogPath = path.join(workspaceDir, 'youtube_post_log.json');

if (videosOnly && imagesOnly) {
    console.error('[ERROR] --videos-only and --images-only cannot be used together.');
    process.exit(1);
}

if (uploadOnly && postOnly) {
    console.error('[ERROR] --upload-only and --post-only cannot be combined.');
    process.exit(1);
}

if (messageId !== null && !messageId) {
    console.error('[ERROR] --message-id requires a WhatsApp message ID value.');
    process.exit(1);
}

if (listMessages && !chats.length) {
    console.error('[ERROR] --list-messages requires at least one chat via --chats "Chat Name".');
    process.exit(1);
}

if ([today, dayOffset !== null, lastDays !== null].filter(Boolean).length > 1) {
    console.error('[ERROR] Use only one of --today, --day-offset, or --last-days.');
    process.exit(1);
}

function buildSharedArgs() {
    const shared = [];
    if (allHistory) {
        shared.push('--all-history');
    }
    if (today) {
        shared.push('--today');
    }
    if (dayOffset !== null) {
        shared.push('--day-offset', String(dayOffset));
    }
    if (lastDays !== null) {
        shared.push('--last-days', String(lastDays));
    }
    if (limit) {
        shared.push('--limit', String(limit));
    }
    if (chats.length) {
        shared.push('--chats', ...chats);
    }
    return shared;
}

function runNodeScript(scriptName, scriptArgs = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(workspaceDir, scriptName), ...scriptArgs], {
            cwd: workspaceDir,
            stdio: 'inherit',
            env: process.env,
        });

        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`${scriptName} terminated by signal ${signal}`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`${scriptName} exited with code ${code}`));
                return;
            }
            resolve();
        });
    });
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

function summarizeImagePostStatuses() {
    const log = loadJson(postLogPath, { posts: [] });
    const posts = Array.isArray(log.posts) ? log.posts : [];
    const pending = posts.filter((entry) => entry?.status === 'pending-manual-publish');
    const retry = posts.filter((entry) => entry?.status === 'retry-manual-publish');

    if (!pending.length && !retry.length) {
        console.log('[INFO] No pending or retry image post batches remain.');
        return;
    }

    console.log(`[INFO] Image post queue summary: ${pending.length} pending-manual-publish, ${retry.length} retry-manual-publish`);
    if (pending.length || retry.length) {
        console.log('[INFO] Image uploads are not blocked in the downloader. These batches still require YouTube image post creation and URL verification.');
    }

    for (const entry of [...retry, ...pending]) {
        console.log(`[QUEUE] ${entry.batchId} | status=${entry.status} | images=${entry.imageCount}`);
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function cleanupMediaFiles() {
    const cutoffMs = cleanupOlderThanDays > 0
        ? Date.now() - cleanupOlderThanDays * 24 * 60 * 60 * 1000
        : null;

    console.log('\n[STEP] Cleaning up media files (logs and *.json metadata preserved)...');
    if (cleanupDryRun) {
        console.log('[INFO] Dry run — no files will be deleted.');
    }
    if (cutoffMs !== null) {
        console.log(`[INFO] Only removing files older than ${cleanupOlderThanDays} day(s).`);
    }

    let totalRemoved = 0;
    let totalBytes = 0;
    let totalSkipped = 0;

    for (const dirName of MEDIA_DIRS) {
        const dirPath = path.join(workspaceDir, dirName);
        if (!fs.existsSync(dirPath)) {
            continue;
        }

        const walk = (current) => {
            let entries;
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch (error) {
                console.warn(`[WARN] Cannot read ${current}: ${error.message}`);
                return;
            }

            for (const entry of entries) {
                const entryPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    walk(entryPath);
                    continue;
                }
                if (!entry.isFile()) {
                    continue;
                }

                const ext = path.extname(entry.name).toLowerCase();
                // Preserve logs and metadata
                if (ext === '.json' || ext === '.log' || ext === '.txt' || ext === '.md') {
                    totalSkipped += 1;
                    continue;
                }
                // Only delete known media extensions to be safe
                if (!MEDIA_EXTENSIONS.has(ext)) {
                    totalSkipped += 1;
                    continue;
                }

                let stat;
                try {
                    stat = fs.statSync(entryPath);
                } catch (error) {
                    console.warn(`[WARN] Cannot stat ${entryPath}: ${error.message}`);
                    continue;
                }

                if (cutoffMs !== null && stat.mtimeMs > cutoffMs) {
                    totalSkipped += 1;
                    continue;
                }

                const relPath = path.relative(workspaceDir, entryPath);
                if (cleanupDryRun) {
                    console.log(`[DRY-RUN] would remove ${relPath} (${formatBytes(stat.size)})`);
                } else {
                    try {
                        fs.unlinkSync(entryPath);
                        console.log(`[REMOVED] ${relPath} (${formatBytes(stat.size)})`);
                    } catch (error) {
                        console.warn(`[WARN] Failed to remove ${relPath}: ${error.message}`);
                        continue;
                    }
                }
                totalRemoved += 1;
                totalBytes += stat.size;
            }
        };

        walk(dirPath);
    }

    const verb = cleanupDryRun ? 'Would remove' : 'Removed';
    console.log(`[OK] ${verb} ${totalRemoved} media file(s), freeing ${formatBytes(totalBytes)}. Preserved ${totalSkipped} non-media file(s).`);
}

async function runCombineStep() {
    const EASTERN_TIME_ZONE = 'America/New_York';
    const IMAGE_METADATA_FILE = path.join(workspaceDir, 'image_metadata.json');
    const VIDEO_METADATA_FILE = path.join(workspaceDir, 'video_metadata.json');
    const OUTPUT_DIR = path.join(workspaceDir, 'combined_day_videos');
    const COMBINED_UPLOAD_LOG = path.join(workspaceDir, 'combined_upload_log.json');
    const YOUTUBE_CLIENT_SECRETS = process.env.YOUTUBE_CLIENT_SECRETS || path.join(workspaceDir, 'youtube_client_secret.json');
    const YOUTUBE_TOKEN_FILE = process.env.YOUTUBE_TOKEN_FILE || path.join(workspaceDir, 'youtube_oauth_token.json');

    const TARGET_DATE = String(combineDate || '').trim();
    const TARGET_CHAT = String(combineChat || '').trim();
    const IMAGE_SECONDS = combineImageSeconds;
    const PRIVACY = combinePrivacy;
    const DRY_RUN = combineDryRun;
    const SKIP_UPLOAD = combineSkipUpload;
    const FORCE = combineForce;
    const KEEP_TEMP = combineKeepTemp;
    const NO_BACKGROUND_MUSIC = combineNoBackgroundMusic;
    const DELETE_AFTER_UPLOAD = !combineKeepOutput;

    // Date selectors inherit from the outer pipeline (--today / --day-offset / --last-days)
    const TODAY = today;
    const DAY_OFFSET = dayOffset !== null ? Number.parseInt(dayOffset, 10) : null;
    const LAST_DAYS = lastDays !== null ? Number.parseInt(lastDays, 10) : null;

    if ([TODAY, DAY_OFFSET !== null, LAST_DAYS !== null, Boolean(TARGET_DATE)].filter(Boolean).length > 1) {
        throw new Error('Combine step: use only one of --today, --day-offset, --last-days, or --combine-date.');
    }

    function ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    function sanitizeFilename(name) {
        return String(name || 'unknown').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
    }

    function saveJson(filePath, value) {
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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

    function formatEasternDate(timestampMs) {
        const parts = formatEasternTimestampParts(timestampMs);
        return `${parts.year}-${parts.month}-${parts.day}`;
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
        return formatter.formatToParts(new Date(timestampMs)).find((part) => part.type === 'timeZoneName')?.value || 'ET';
    }

    function getEasternDayNumber(timestampMs) {
        const parts = formatEasternTimestampParts(timestampMs);
        return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000);
    }

    function getSelectedDates() {
        if (TARGET_DATE) {
            return [TARGET_DATE];
        }
        const todayDay = getEasternDayNumber(Date.now());
        if (TODAY) {
            return [formatEasternDate(Date.now())];
        }
        const NOON_UTC_MS = 12 * 60 * 60 * 1000;
        if (DAY_OFFSET !== null) {
            return [formatEasternDate((todayDay - DAY_OFFSET) * 86400000 + NOON_UTC_MS)];
        }
        if (LAST_DAYS !== null) {
            return Array.from({ length: LAST_DAYS }, (_, index) => formatEasternDate((todayDay - index) * 86400000 + NOON_UTC_MS)).reverse();
        }
        const allDates = new Set();
        for (const item of [...(loadJson(IMAGE_METADATA_FILE, { images: [] }).images || []), ...(loadJson(VIDEO_METADATA_FILE, { videos: [] }).videos || [])]) {
            if (item?.timestamp) {
                allDates.add(formatEasternDate(item.timestamp));
            }
        }
        const sortedDates = [...allDates].sort();
        return sortedDates.length ? [sortedDates[sortedDates.length - 1]] : [];
    }

    function runCommand(command, commandArgs, options = {}) {
        return new Promise((resolve, reject) => {
            const child = spawn(command, commandArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                ...options,
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                    return;
                }
                reject(new Error(`${command} exited with code ${code}\n${stderr || stdout}`));
            });
        });
    }

    async function ffprobeDuration(filePath) {
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath,
        ]);
        const duration = Number.parseFloat(stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error(`Could not determine duration for ${filePath}`);
        }
        return duration;
    }

    function loadMedia() {
        const imageMetadata = loadJson(IMAGE_METADATA_FILE, { images: [] });
        const videoMetadata = loadJson(VIDEO_METADATA_FILE, { videos: [] });
        const images = (imageMetadata.images || []).filter((item) => item?.filepath && fs.existsSync(item.filepath)).map((item) => ({ ...item, mediaType: 'image' }));
        const videos = (videoMetadata.videos || []).filter((item) => item?.filepath && fs.existsSync(item.filepath)).map((item) => ({ ...item, mediaType: 'video' }));
        return [...images, ...videos].sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
    }

    function groupMediaByDateAndChat(mediaItems) {
        const groups = new Map();
        for (const item of mediaItems) {
            const date = formatEasternDate(item.timestamp);
            if (TARGET_CHAT && item.chatName !== TARGET_CHAT) {
                continue;
            }
            const key = `${date}::${item.chatName}`;
            if (!groups.has(key)) {
                groups.set(key, { date, chatName: item.chatName, chatId: item.chatId, items: [] });
            }
            groups.get(key).items.push(item);
        }
        return [...groups.values()].sort((left, right) => `${left.date} ${left.chatName}`.localeCompare(`${right.date} ${right.chatName}`));
    }

    function buildCombinedTitle(group) {
        return `${group.chatName} ${group.date} combined media`.slice(0, 100);
    }

    function buildCombinedDescription(group) {
        const lines = [
            `Combined WhatsApp media for ${group.chatName}`,
            `Date: ${group.date} ${EASTERN_TIME_ZONE}`,
            `Items: ${group.items.length}`,
            '',
        ];
        for (const item of group.items) {
            const caption = String(item.caption || '').replace(/\s+/g, ' ').trim();
            lines.push(`- ${item.mediaType.toUpperCase()} | ${formatEasternTimestampIsoLike(item.timestamp)} ${getEasternTimeZoneAbbreviation(item.timestamp)} | ${caption || '[no caption]'}`);
        }
        return lines.join('\n').slice(0, 5000);
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
        const preferred = redirectUris.find((uri) => uri.startsWith('http://127.0.0.1')) || redirectUris.find((uri) => uri.startsWith('http://localhost'));
        if (preferred) {
            const parsed = new URL(preferred);
            const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
            const port = parsed.port || '8787';
            const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/oauth2callback';
            return `${parsed.protocol}//${host}:${port}${pathname}`;
        }
        return 'http://127.0.0.1:8787/oauth2callback';
    }

    async function getYouTubeAuthClient() {
        if (!fs.existsSync(YOUTUBE_CLIENT_SECRETS)) {
            throw new Error(`OAuth client secrets file not found: ${YOUTUBE_CLIENT_SECRETS}`);
        }
        if (!fs.existsSync(YOUTUBE_TOKEN_FILE)) {
            throw new Error(`OAuth token file not found: ${YOUTUBE_TOKEN_FILE}`);
        }
        const secrets = loadClientSecrets(YOUTUBE_CLIENT_SECRETS);
        const oauth2Client = new google.auth.OAuth2(secrets.client_id, secrets.client_secret, resolveRedirectUri(secrets));
        oauth2Client.setCredentials(JSON.parse(fs.readFileSync(YOUTUBE_TOKEN_FILE, 'utf8')));
        return oauth2Client;
    }

    async function uploadVideo(outputPath, title, description) {
        const auth = await getYouTubeAuthClient();
        const youtube = google.youtube({ version: 'v3', auth });
        const response = await youtube.videos.insert({
            part: ['snippet', 'status'],
            requestBody: {
                snippet: { title, description },
                status: { privacyStatus: PRIVACY, selfDeclaredMadeForKids: false },
            },
            media: { body: fs.createReadStream(outputPath) },
        });
        if (!response.data.id) {
            throw new Error('Upload completed without returning a video ID');
        }
        return {
            videoId: response.data.id,
            url: `https://www.youtube.com/watch?v=${response.data.id}`,
        };
    }

    async function createImageSegment(item, tempDir, index) {
        const outputPath = path.join(tempDir, `segment_${String(index).padStart(4, '0')}.mp4`);
        await runCommand('ffmpeg', [
            '-y',
            '-loop', '1',
            '-i', item.filepath,
            '-f', 'lavfi',
            '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-t', String(IMAGE_SECONDS),
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p',
            '-r', '30',
            '-c:a', 'aac',
            '-shortest',
            outputPath,
        ]);
        return outputPath;
    }

    async function createVideoSegment(item, tempDir, index) {
        const outputPath = path.join(tempDir, `segment_${String(index).padStart(4, '0')}.mp4`);
        await runCommand('ffmpeg', [
            '-y',
            '-i', item.filepath,
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p',
            '-r', '30',
            '-c:a', 'aac',
            '-ar', '48000',
            '-movflags', '+faststart',
            outputPath,
        ]);
        return outputPath;
    }

    async function addBackgroundMusic(inputVideoPath, outputVideoPath, durationSeconds) {
        const safeDuration = Math.max(1, Math.ceil(durationSeconds));
        await runCommand('ffmpeg', [
            '-y',
            '-i', inputVideoPath,
            '-f', 'lavfi',
            '-t', String(safeDuration),
            '-i', 'sine=frequency=261.63:sample_rate=48000,volume=0.015',
            '-f', 'lavfi',
            '-t', String(safeDuration),
            '-i', 'sine=frequency=329.63:sample_rate=48000,volume=0.01',
            '-f', 'lavfi',
            '-t', String(safeDuration),
            '-i', 'sine=frequency=392.00:sample_rate=48000,volume=0.008',
            '-filter_complex', '[1:a][2:a][3:a]amix=inputs=3:normalize=0[music];[0:a][music]amix=inputs=2:weights=1 0.22:normalize=0[aout]',
            '-map', '0:v:0',
            '-map', '[aout]',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-shortest',
            '-movflags', '+faststart',
            outputVideoPath,
        ]);
    }

    async function buildCombinedVideo(group) {
        ensureDir(OUTPUT_DIR);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-day-media-'));
        try {
            const segmentPaths = [];
            for (let index = 0; index < group.items.length; index += 1) {
                const item = group.items[index];
                console.log(`[INFO] Preparing ${item.mediaType} ${index + 1}/${group.items.length}: ${path.basename(item.filepath)}`);
                const segmentPath = item.mediaType === 'image'
                    ? await createImageSegment(item, tempDir, index)
                    : await createVideoSegment(item, tempDir, index);
                segmentPaths.push(segmentPath);
            }

            const concatFile = path.join(tempDir, 'concat.txt');
            fs.writeFileSync(concatFile, `${segmentPaths.map((segmentPath) => `file '${segmentPath.replace(/'/g, `'\\''`)}'`).join('\n')}\n`);

            const outputFilename = `${sanitizeFilename(group.chatName)}_${group.date}_combined.mp4`;
            const outputPath = path.join(OUTPUT_DIR, outputFilename);
            const baseOutputPath = path.join(tempDir, 'combined_base.mp4');
            await runCommand('ffmpeg', [
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', concatFile,
                '-c', 'copy',
                baseOutputPath,
            ]);

            const duration = await ffprobeDuration(baseOutputPath);
            if (NO_BACKGROUND_MUSIC) {
                fs.copyFileSync(baseOutputPath, outputPath);
            } else {
                await addBackgroundMusic(baseOutputPath, outputPath, duration);
            }
            return { outputPath, duration, tempDir };
        } catch (error) {
            if (!KEEP_TEMP) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            throw error;
        }
    }

    function findExistingUpload(log, group) {
        return (log.uploads || []).find((entry) => entry?.date === group.date && entry?.chatName === group.chatName && !entry?.error);
    }

    console.log('========================================');
    console.log('Combine Same-Day Media To Video');
    console.log('========================================');
    console.log(`[CONFIG] Date selector: ${TARGET_DATE || (TODAY ? 'today' : DAY_OFFSET !== null ? `day-offset ${DAY_OFFSET}` : LAST_DAYS !== null ? `last-days ${LAST_DAYS}` : 'all dates')}`);
    console.log(`[CONFIG] Chat filter: ${TARGET_CHAT || 'all chats'}`);
    console.log(`[CONFIG] Image seconds: ${IMAGE_SECONDS}`);
    console.log(`[CONFIG] Privacy: ${PRIVACY}`);
    console.log(`[CONFIG] Dry run: ${DRY_RUN}`);
    console.log(`[CONFIG] Skip upload: ${SKIP_UPLOAD}`);
    console.log(`[CONFIG] Background music: ${NO_BACKGROUND_MUSIC ? 'disabled' : 'generated ambient bed'}`);
    console.log(`[CONFIG] Delete output after upload: ${DELETE_AFTER_UPLOAD}`);
    console.log('========================================');

    const selectedDates = new Set(getSelectedDates());
    const mediaItems = loadMedia().filter((item) => selectedDates.has(formatEasternDate(item.timestamp)));
    const groups = groupMediaByDateAndChat(mediaItems).filter((group) => selectedDates.has(group.date));

    if (!groups.length) {
        console.log('[INFO] No same-day media groups found for the selected filters; skipping combine step.');
        return;
    }

    const log = loadJson(COMBINED_UPLOAD_LOG, { uploads: [] });
    const uploadedResults = [];
    let processedCount = 0;

    for (const group of groups) {
        const existingUpload = findExistingUpload(log, group);
        if (existingUpload && !FORCE) {
            console.log(`[SKIP] Already uploaded combined video for ${group.chatName} on ${group.date}: ${existingUpload.url}`);
            continue;
        }

        console.log(`[INFO] Building combined video for ${group.chatName} on ${group.date} with ${group.items.length} items`);
        if (DRY_RUN) {
            console.log(`[DRY-RUN] Would combine ${group.items.length} items and ${SKIP_UPLOAD ? 'skip upload' : 'upload result'} for ${group.chatName} on ${group.date}`);
            continue;
        }

        const { outputPath, duration, tempDir } = await buildCombinedVideo(group);
        console.log(`[SUCCESS] Combined video created: ${outputPath}`);
        console.log(`[INFO] Duration: ${duration.toFixed(2)} seconds`);

        const title = buildCombinedTitle(group);
        const description = buildCombinedDescription(group);
        let uploadResult = null;

        if (!SKIP_UPLOAD) {
            console.log(`[INFO] Uploading combined video to YouTube: ${title}`);
            uploadResult = await uploadVideo(outputPath, title, description);
            console.log(`[SUCCESS] Uploaded combined video: ${uploadResult.url}`);
            uploadedResults.push({
                date: group.date,
                chatName: group.chatName,
                videoId: uploadResult.videoId,
                url: uploadResult.url,
                outputPath,
            });
        }

        log.uploads = (log.uploads || []).filter((entry) => !(entry?.date === group.date && entry?.chatName === group.chatName));
        log.uploads.push({
            date: group.date,
            chatName: group.chatName,
            chatId: group.chatId,
            itemCount: group.items.length,
            outputPath,
            duration,
            title,
            uploadedAt: new Date().toISOString(),
            videoId: uploadResult?.videoId || null,
            url: uploadResult?.url || null,
            privacy: PRIVACY,
            items: group.items.map((item) => ({
                mediaType: item.mediaType,
                messageId: item.messageId,
                filepath: item.filepath,
                timestamp: item.timestamp,
            })),
        });
        saveJson(COMBINED_UPLOAD_LOG, log);

        if (uploadResult && DELETE_AFTER_UPLOAD && fs.existsSync(outputPath)) {
            fs.rmSync(outputPath, { force: true });
            console.log(`[CLEANUP] Deleted combined video after upload: ${outputPath}`);
        }

        if (!KEEP_TEMP) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }

        processedCount += 1;
    }

    if (DRY_RUN || SKIP_UPLOAD) {
        console.log('[DONE] Combine process completed without upload.');
        return;
    }

    if (uploadedResults.length) {
        console.log(JSON.stringify({
            uploadedCount: uploadedResults.length,
            processedCount,
            uploads: uploadedResults,
        }, null, 2));
        return;
    }

    console.log('[INFO] No combined videos required upload this run.');
}

async function main() {
    console.log('========================================');
    console.log('WhatsApp to YouTube Main Pipeline');
    console.log('========================================');

    if (cleanupOnly) {
        cleanupMediaFiles();
        console.log('\n[OK] Cleanup-only run completed.');
        return;
    }

    if (combineOnly) {
        await runCombineStep();
        if (cleanupMedia) {
            cleanupMediaFiles();
        }
        console.log('\n[OK] Combine-only run completed.');
        return;
    }

    if (!skipAuth) {
        console.log('\n[STEP] Checking WhatsApp Web auth...');
        await runNodeScript('check_whatsapp_wwebjs_auth.mjs', loginIfNeeded ? ['--login-if-needed'] : []);

        if (!listMessages) {
            console.log('\n[STEP] Checking YouTube auth...');
            await runNodeScript('check_youtube_auth.mjs', loginIfNeeded ? ['--login-if-needed'] : []);
        }
    }

    if (listMessages) {
        for (const chat of chats) {
            console.log(`\n[STEP] Listing WhatsApp messages with names for: ${chat}`);
            const listArgs = [chat, String(limit)];
            if (today) {
                listArgs.push('--today');
            }
            if (dayOffset !== null) {
                listArgs.push('--day-offset', String(dayOffset));
            }
            if (lastDays !== null) {
                listArgs.push('--last-days', String(lastDays));
            }
            await runNodeScript('list_historic_messages_wwebjs.mjs', listArgs);
        }
        console.log('\n[OK] Main pipeline completed.');
        return;
    }

    const sharedArgs = buildSharedArgs();

    if (!imagesOnly) {
        const videoArgs = [...sharedArgs];
        if (downloadOnly) {
            videoArgs.push('--download-only');
        }
        if (uploadOnly) {
            videoArgs.push('--upload-only');
        }
        if (forceUpload) {
            videoArgs.push('--force-upload');
        }
        if (messageId) {
            videoArgs.push('--message-id', messageId);
        }
        if (verifyYouTube || reuploadMissingYouTube) {
            videoArgs.push('--verify-youtube');
        }
        if (reuploadMissingYouTube) {
            videoArgs.push('--reupload-missing-youtube');
        }

        console.log('\n[STEP] Running video pipeline...');
        await runNodeScript('download_and_upload_wwebjs.mjs', videoArgs);
    }

    if (!videosOnly) {
        const imageArgs = [...sharedArgs];
        if (downloadOnly) {
            imageArgs.push('--download-only');
        }
        if (!postOnly) {
            console.log('\n[STEP] Running image pipeline...');
            await runNodeScript('download_and_post_images_wwebjs.mjs', imageArgs);

            console.log('\n[STEP] Verifying image post queue consistency...');
            await runNodeScript('verify_youtube_image_posts.mjs', []);

            console.log('\n[STEP] Summarizing image post queue...');
            summarizeImagePostStatuses();

            console.log('\n[STEP] Showing next actionable image post batch...');
            await runNodeScript('process_image_post_queue.mjs', ['--next']);
        } else {
            const postArgs = ['--next', '--mark-verified'];
            if (includeRetry) {
                postArgs.push('--include-retry');
            }

            console.log('\n[STEP] Posting next queued image batch via Playwright...');
            await runNodeScript('post_youtube_images_playwright.mjs', postArgs);
        }
    }

    if (!listMessages && !combineSkip) {
        console.log('\n[STEP] Combining same-day media into per-chat videos...');
        await runCombineStep();
    }

    if (cleanupMedia) {
        cleanupMediaFiles();
    }

    console.log('\n[OK] Main pipeline completed.');
}

main().catch((error) => {
    console.error(`\n[ERROR] ${error.message}`);
    process.exit(1);
});