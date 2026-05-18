#!/usr/bin/env node

import fs from 'fs';
import http from 'http';
import path from 'path';
import { google } from 'googleapis';
import open from 'open';

const args = process.argv.slice(2);
const DELETE_MODE = args.includes('--delete');
const LOGIN_IF_NEEDED = args.includes('--login-if-needed');
const DRY_RUN = args.includes('--dry-run') || !DELETE_MODE;
const clientSecretsPath = path.join(process.cwd(), 'youtube_client_secret.json');
const tokenPath = path.join(process.cwd(), 'youtube_oauth_token.json');
const uploadLogPath = path.join(process.cwd(), 'upload_log.json');

function printUsage() {
    console.log('Usage: node dedupe_youtube_videos.mjs [--delete] [--dry-run] [--login-if-needed]');
    console.log('');
    console.log('Finds likely duplicate YouTube videos using upload_log.json and YouTube channel data.');
    console.log('Default mode is dry-run and only reports duplicates.');
    console.log('Use --delete to delete older duplicates after verification.');
}

if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
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

async function getAuthenticatedClient() {
    if (!fs.existsSync(clientSecretsPath)) {
        throw new Error(`OAuth client secrets file not found: ${clientSecretsPath}`);
    }

    const secrets = loadClientSecrets(clientSecretsPath);
    const redirectUri = resolveRedirectUri(secrets);
    const redirectUrl = new URL(redirectUri);
    const listenHost = redirectUrl.hostname === 'localhost' ? '127.0.0.1' : redirectUrl.hostname;
    const listenPort = Number(redirectUrl.port || 80);
    const oauth2Client = new google.auth.OAuth2(secrets.client_id, secrets.client_secret, redirectUri);

    async function runInteractiveLogin() {
        if (!LOGIN_IF_NEEDED) {
            throw new Error('YouTube login required for duplicate detection');
        }

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: ['https://www.googleapis.com/auth/youtube.force-ssl'],
        });

        const code = await waitForOAuthCode(`${redirectUrl.protocol}//${redirectUrl.host}${redirectUrl.pathname}`, authUrl, listenHost, listenPort);
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
        console.log(`[INFO] Saved OAuth token to ${tokenPath}`);
        return oauth2Client;
    }

    if (!fs.existsSync(tokenPath)) {
        return runInteractiveLogin();
    }

    oauth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));

    try {
        const accessToken = await oauth2Client.getAccessToken();
        const tokenValue = typeof accessToken === 'string' ? accessToken : accessToken?.token;
        const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(tokenValue)}`);
        const tokenInfo = await response.json();
        const scope = String(tokenInfo.scope || '');
        if (!scope.split(/\s+/).includes('https://www.googleapis.com/auth/youtube.force-ssl')) {
            if (!LOGIN_IF_NEEDED) {
                throw new Error('Authenticated token is missing youtube.force-ssl scope');
            }
            console.log('[INFO] Existing YouTube token is missing youtube.force-ssl scope. Re-running interactive login.');
            fs.rmSync(tokenPath, { force: true });
            oauth2Client.setCredentials({});
            return runInteractiveLogin();
        }
        return oauth2Client;
    } catch (error) {
        const message = String(error?.message || error);
        if (!/invalid_grant/i.test(message) && !/youtube\.force-ssl/i.test(message)) {
            throw error;
        }

        console.log('[INFO] Existing YouTube token is invalid or missing required scope. Re-running interactive login.');
        fs.rmSync(tokenPath, { force: true });
        oauth2Client.setCredentials({});
        return runInteractiveLogin();
    }
}

async function getUploadsPlaylistId(youtube) {
    const response = await youtube.channels.list({
        part: ['contentDetails'],
        mine: true,
    });
    const uploadsPlaylistId = response.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
        throw new Error('Could not resolve uploads playlist for authenticated channel');
    }
    return uploadsPlaylistId;
}

async function listAllUploadedVideos(youtube) {
    const uploadsPlaylistId = await getUploadsPlaylistId(youtube);
    const videos = [];
    let pageToken;

    do {
        const response = await youtube.playlistItems.list({
            part: ['snippet', 'contentDetails'],
            playlistId: uploadsPlaylistId,
            maxResults: 50,
            pageToken,
        });

        for (const item of response.data.items || []) {
            const videoId = item.contentDetails?.videoId;
            if (!videoId) {
                continue;
            }
            videos.push({
                videoId,
                title: item.snippet?.title || '',
                publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
            });
        }

        pageToken = response.data.nextPageToken;
    } while (pageToken);

    return videos;
}

function buildLogIndex(uploadLog) {
    const byVideoId = new Map();
    const byTitle = new Map();
    const byFilename = new Map();
    const byMessageId = new Map();

    for (const entry of uploadLog.uploaded || []) {
        if (entry?.videoId) {
            byVideoId.set(entry.videoId, entry);
        }
        if (entry?.title) {
            const titleEntries = byTitle.get(entry.title) || [];
            titleEntries.push(entry);
            byTitle.set(entry.title, titleEntries);
        }
        if (entry?.filename) {
            const filenameEntries = byFilename.get(entry.filename) || [];
            filenameEntries.push(entry);
            byFilename.set(entry.filename, filenameEntries);
        }
        if (entry?.messageId) {
            const messageEntries = byMessageId.get(entry.messageId) || [];
            messageEntries.push(entry);
            byMessageId.set(entry.messageId, messageEntries);
        }
    }

    return { byVideoId, byTitle, byFilename, byMessageId };
}

function findDuplicateGroups(channelVideos, uploadLog) {
    const { byVideoId, byTitle, byFilename, byMessageId } = buildLogIndex(uploadLog);
    const groups = new Map();

    for (const video of channelVideos) {
        const logEntry = byVideoId.get(video.videoId);
        if (!logEntry?.messageId || !logEntry?.filename || !logEntry?.title) {
            continue;
        }

        const key = logEntry.messageId;
        const group = groups.get(key) || [];
        group.push({
            videoId: video.videoId,
            title: logEntry.title,
            publishedAt: video.publishedAt,
            logEntry,
            filename: logEntry.filename,
            messageId: logEntry.messageId,
        });
        groups.set(key, group);
    }

    const duplicates = [];
    for (const [messageId, entries] of groups.entries()) {
        if (entries.length < 2) {
            continue;
        }

        const distinctFilenames = new Set(entries.map((entry) => entry.filename).filter(Boolean));
        const matchingLogEntries = byMessageId.get(messageId) || [];
        const matchingFilenameEntries = entries[0]?.filename ? (byFilename.get(entries[0].filename) || []) : [];
        const matchingTitleEntries = entries[0]?.title ? (byTitle.get(entries[0].title) || []) : [];

        if (distinctFilenames.size > 1) {
            continue;
        }

        duplicates.push({
            title: entries[0].title,
            messageId,
            entries: entries.sort((left, right) => Date.parse(left.publishedAt || 0) - Date.parse(right.publishedAt || 0)),
            matchingLogEntries,
            matchingFilenameEntries,
            matchingTitleEntries,
        });
    }

    return duplicates;
}

async function deleteDuplicateVideos(youtube, duplicates) {
    for (const group of duplicates) {
        const keep = group.entries[group.entries.length - 1];
        const remove = group.entries.slice(0, -1);

        console.log(`\n[DUPLICATE] ${group.title}`);
        console.log(`[KEEP] ${keep.videoId} | publishedAt=${keep.publishedAt || 'unknown'} | filename=${keep.filename || 'n/a'}`);

        for (const entry of remove) {
            console.log(`[DELETE] ${entry.videoId} | publishedAt=${entry.publishedAt || 'unknown'} | filename=${entry.filename || 'n/a'}`);
            if (!DRY_RUN) {
                await youtube.videos.delete({ id: entry.videoId });
            }
        }
    }
}

async function main() {
    const uploadLog = loadJson(uploadLogPath, { uploaded: [] });
    const auth = await getAuthenticatedClient();
    const youtube = google.youtube({ version: 'v3', auth });
    const channelVideos = await listAllUploadedVideos(youtube);
    const duplicates = findDuplicateGroups(channelVideos, uploadLog);

    if (!duplicates.length) {
        console.log('[OK] No likely duplicate YouTube videos found.');
        return;
    }

    console.log(`[INFO] Found ${duplicates.length} likely duplicate title groups.`);
    await deleteDuplicateVideos(youtube, duplicates);

    if (DRY_RUN) {
        console.log('\n[INFO] Dry run only. Re-run with --delete --login-if-needed to remove the older duplicates.');
    } else {
        console.log('\n[OK] Duplicate deletion complete.');
    }
}

main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
});