#!/usr/bin/env node

import fs from 'fs';
import http from 'http';
import path from 'path';
import { google } from 'googleapis';
import open from 'open';

const args = process.argv.slice(2);
const LOGIN_IF_NEEDED = args.includes('--login-if-needed');
const APPLY = args.includes('--apply');
const DRY_RUN = !APPLY;
const clientSecretsPath = path.join(process.cwd(), 'youtube_client_secret.json');
const tokenPath = path.join(process.cwd(), 'youtube_oauth_token.json');
const uploadLogPath = path.join(process.cwd(), 'upload_log.json');
const EASTERN_TIME_ZONE = 'America/New_York';

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

const TARGET_CHATS = collectFlagValues(args, '--chats');

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
            throw new Error('YouTube login required for rename operation');
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

function sanitizeFilename(name) {
    return String(name || 'unknown').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
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

function extractTitleLead(entry) {
    const caption = String(entry?.caption || '').replace(/\s+/g, ' ').trim();
    if (!caption) {
        return sanitizeFilename(entry?.chatName || 'WhatsApp video');
    }

    const firstSegment = caption.split(/[\n|,.;:!?]/)[0]?.trim() || caption;
    const cleaned = firstSegment.replace(/^[@#~\-\s]+/, '').trim();
    if (!cleaned) {
        return sanitizeFilename(entry?.chatName || 'WhatsApp video');
    }

    return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 57).trimEnd()}...`;
}

function buildDesiredTitle(entry) {
    const lead = extractTitleLead(entry);
    const timestamp = formatEasternTimestampForTitle(entry.timestamp || Date.now());
    const rawTitle = `${lead} posted on ${timestamp}`;
    return rawTitle.length <= 100 ? rawTitle : `${rawTitle.slice(0, 97).trimEnd()}...`;
}

function buildDesiredDescription(entry) {
    const lines = [
        `Video from WhatsApp chat: ${entry.chatName || 'unknown'}`,
        `Date: ${formatEasternTimestampForTitle(entry.timestamp || Date.now())}`,
    ];
    if (entry.filename) {
        lines.push(`Original filename: ${entry.filename}`);
    }
    if (entry.caption) {
        lines.push('', entry.caption);
    }
    return lines.join('\n');
}

function inferChatName(entry) {
    if (entry?.chatName) {
        return entry.chatName;
    }

    const filename = String(entry?.filename || '');
    const knownChats = [
        'JESUS CHRIST THE ONLY WAY',
        'JESUS CHRIST is the LORD',
        '5 Minutes for Jesus Christ',
    ];
    const matchedChat = knownChats.find((chat) => filename.startsWith(`${chat}_`));
    if (matchedChat) {
        return matchedChat;
    }

    return 'unknown';
}

function inferTimestamp(entry) {
    if (entry?.timestamp) {
        return entry.timestamp;
    }

    const existingTitle = String(entry?.title || '');
    const titleMatch = existingTitle.match(/ posted on (\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})-(EDT|EST)$/);
    if (titleMatch) {
        const [, datePart, hour, minute, second] = titleMatch;
        const parsedFromTitle = new Date(`${datePart}T${hour}:${minute}:${second}.000`).getTime();
        if (!Number.isNaN(parsedFromTitle)) {
            return parsedFromTitle;
        }
    }

    const filename = String(entry?.filename || '');
    const match = filename.match(/_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})(?:Z)?_/);
    if (!match) {
        return Date.now();
    }

    const [, datePart, hour, minute, second, millisecond] = match;
    const easternTitle = `${datePart}-${hour}-${minute}-${second}`;
    const uploadLog = loadJson(uploadLogPath, { uploaded: [] });
    const matchingEntry = (uploadLog.uploaded || []).find((candidate) => {
        if (candidate === entry) {
            return false;
        }
        if (candidate?.filename !== entry?.filename) {
            return false;
        }
        const title = String(candidate?.title || '');
        return title.includes(`posted on ${easternTitle}-`);
    });

    if (matchingEntry?.title) {
        return matchingEntry.timestamp || entry.timestamp || Date.now();
    }

    const localParsed = new Date(`${datePart}T${hour}:${minute}:${second}.${millisecond}`).getTime();
    return Number.isNaN(localParsed) ? Date.now() : localParsed;
}

function enrichEntry(entry) {
    return {
        ...entry,
        chatName: inferChatName(entry),
        timestamp: inferTimestamp(entry),
    };
}

function buildRenameCandidates(uploadLog) {
    return (uploadLog.uploaded || [])
        .filter((entry) => entry?.videoId && !entry?.error)
        .map((entry) => enrichEntry(entry))
        .filter((entry) => !TARGET_CHATS.length || TARGET_CHATS.includes(entry.chatName))
        .map((entry) => ({
            ...entry,
            desiredTitle: buildDesiredTitle(entry),
        }));
}

async function fetchVideoSnippet(youtube, videoId) {
    const response = await youtube.videos.list({
        part: ['snippet', 'status'],
        id: [videoId],
        maxResults: 1,
    });
    return response.data.items?.[0] || null;
}

function buildWritableSnippet(currentSnippet, title, description) {
    return {
        title,
        description,
        categoryId: currentSnippet?.categoryId || '22',
    };
}

async function renameVideos(youtube, candidates) {
    let changed = 0;
    for (const candidate of candidates) {
        const current = await fetchVideoSnippet(youtube, candidate.videoId);
        if (!current?.snippet) {
            console.log(`[WARN] Could not load current snippet for ${candidate.videoId}`);
            continue;
        }

        const currentTitle = current.snippet.title || '';
        const desiredDescription = buildDesiredDescription(candidate);
        const titleChanged = currentTitle !== candidate.desiredTitle;
        const descriptionChanged = (current.snippet.description || '') !== desiredDescription;
        if (!titleChanged && !descriptionChanged) {
            continue;
        }

        changed += 1;
        console.log(`[UPDATE] ${candidate.videoId}`);
        if (titleChanged) {
            console.log(`  title from: ${currentTitle}`);
            console.log(`  title to:   ${candidate.desiredTitle}`);
        }
        if (descriptionChanged) {
            console.log('  description: will be updated');
        }

        if (DRY_RUN) {
            continue;
        }

        await youtube.videos.update({
            part: ['snippet'],
            requestBody: {
                id: candidate.videoId,
                snippet: buildWritableSnippet(current.snippet, candidate.desiredTitle, desiredDescription),
            },
        });
    }

    return changed;
}

async function main() {
    const uploadLog = loadJson(uploadLogPath, { uploaded: [] });
    const candidates = buildRenameCandidates(uploadLog);
    if (!candidates.length) {
        console.log('[OK] No uploaded videos matched the requested chats.');
        return;
    }

    console.log(`[INFO] Rename mode: ${DRY_RUN ? 'dry-run preview' : 'apply changes'}`);

    const auth = await getAuthenticatedClient();
    const youtube = google.youtube({ version: 'v3', auth });
    const changed = await renameVideos(youtube, candidates);

    if (!changed) {
        console.log('[OK] No YouTube video titles needed renaming.');
        return;
    }

    if (DRY_RUN) {
        console.log(`[INFO] Dry run only. ${changed} videos would be renamed.`);
    } else {
        console.log(`[OK] Renamed ${changed} YouTube videos.`);
    }
}

main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
});