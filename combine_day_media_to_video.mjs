#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { google } from 'googleapis';

const EASTERN_TIME_ZONE = 'America/New_York';
const IMAGE_METADATA_FILE = path.join(process.cwd(), 'image_metadata.json');
const VIDEO_METADATA_FILE = path.join(process.cwd(), 'video_metadata.json');
const OUTPUT_DIR = path.join(process.cwd(), 'combined_day_videos');
const COMBINED_UPLOAD_LOG = path.join(process.cwd(), 'combined_upload_log.json');
const YOUTUBE_CLIENT_SECRETS = process.env.YOUTUBE_CLIENT_SECRETS || path.join(process.cwd(), 'youtube_client_secret.json');
const YOUTUBE_TOKEN_FILE = process.env.YOUTUBE_TOKEN_FILE || path.join(process.cwd(), 'youtube_oauth_token.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const KEEP_TEMP = args.includes('--keep-temp');
const SKIP_UPLOAD = args.includes('--skip-upload');
const FORCE = args.includes('--force');
const NO_BACKGROUND_MUSIC = args.includes('--no-background-music');
const DELETE_AFTER_UPLOAD = !args.includes('--keep-output');
const TODAY = args.includes('--today');
const DAY_OFFSET_INDEX = args.indexOf('--day-offset');
const DAY_OFFSET = DAY_OFFSET_INDEX !== -1 ? Number.parseInt(args[DAY_OFFSET_INDEX + 1] || '0', 10) : null;
const LAST_DAYS_INDEX = args.indexOf('--last-days');
const LAST_DAYS = LAST_DAYS_INDEX !== -1 ? Number.parseInt(args[LAST_DAYS_INDEX + 1] || '1', 10) : null;
const DATE_INDEX = args.indexOf('--date');
const TARGET_DATE = DATE_INDEX !== -1 ? String(args[DATE_INDEX + 1] || '').trim() : '';
const CHAT_INDEX = args.indexOf('--chat');
const TARGET_CHAT = CHAT_INDEX !== -1 ? String(args[CHAT_INDEX + 1] || '').trim() : '';
const IMAGE_SECONDS_INDEX = args.indexOf('--image-seconds');
const IMAGE_SECONDS = IMAGE_SECONDS_INDEX !== -1 ? Number.parseFloat(args[IMAGE_SECONDS_INDEX + 1] || '3') : 3;
const PRIVACY_INDEX = args.indexOf('--privacy');
const PRIVACY = PRIVACY_INDEX !== -1 ? String(args[PRIVACY_INDEX + 1] || 'public').trim() : 'public';

function printUsage() {
    console.log('Usage: node combine_day_media_to_video.mjs [--today | --day-offset N | --last-days N | --date YYYY-MM-DD] [--chat "Chat Name"] [--image-seconds 3] [--privacy public|unlisted|private] [--skip-upload] [--dry-run] [--force] [--keep-temp] [--no-background-music] [--keep-output]');
}

if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
}

if ([TODAY, DAY_OFFSET !== null, LAST_DAYS !== null, Boolean(TARGET_DATE)].filter(Boolean).length > 1) {
    console.error('[ERROR] Use only one of --today, --day-offset, --last-days, or --date.');
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

if (!Number.isFinite(IMAGE_SECONDS) || IMAGE_SECONDS <= 0) {
    console.error('[ERROR] --image-seconds requires a positive number.');
    process.exit(1);
}

if (!['private', 'unlisted', 'public'].includes(PRIVACY)) {
    console.error(`[ERROR] Invalid privacy value: ${PRIVACY}`);
    process.exit(1);
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function sanitizeFilename(name) {
    return String(name || 'unknown').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
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
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
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
            groups.set(key, {
                date,
                chatName: item.chatName,
                chatId: item.chatId,
                items: [],
            });
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
        media: {
            body: fs.createReadStream(outputPath),
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

function loadCombinedUploadLog() {
    return loadJson(COMBINED_UPLOAD_LOG, { uploads: [] });
}

function saveCombinedUploadLog(log) {
    saveJson(COMBINED_UPLOAD_LOG, log);
}

function findExistingUpload(log, group) {
    return (log.uploads || []).find((entry) => entry?.date === group.date && entry?.chatName === group.chatName && !entry?.error);
}

async function main() {
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
        throw new Error('No same-day media groups found for the selected filters.');
    }

    const log = loadCombinedUploadLog();
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
        saveCombinedUploadLog(log);

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

    throw new Error('No combined video was uploaded.');
}

main().catch((error) => {
    console.error(`[ERROR] ${error.message || error}`);
    process.exit(1);
});