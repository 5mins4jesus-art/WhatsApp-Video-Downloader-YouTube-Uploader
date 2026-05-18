#!/usr/bin/env node

import fs from 'fs';
import http from 'http';
import path from 'path';
import { google } from 'googleapis';
import open from 'open';

const args = process.argv.slice(2);

function getArg(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] ?? fallback;
}

function requireArg(name) {
  const value = getArg(name);
  if (!value) {
    console.error(`[ERROR] Missing required argument: ${name}`);
    process.exit(1);
  }
  return value;
}

const videoPath = args[0];
const title = getArg('--title', videoPath ? path.parse(videoPath).name : 'video');
const description = getArg('--description', '');
const privacyStatus = getArg('--privacy', 'private');
const clientSecretsPath = getArg('--client-secrets', path.join(process.cwd(), 'youtube_client_secret.json'));
const tokenPath = getArg('--token-file', path.join(process.cwd(), 'youtube_oauth_token.json'));

if (!videoPath) {
  console.error('Usage: node youtube_oauth_upload.mjs <videoPath> [--title <title>] [--description <description>] [--privacy private|unlisted|public] [--client-secrets <path>] [--token-file <path>]');
  process.exit(1);
}

if (!fs.existsSync(videoPath)) {
  console.error(`[ERROR] Video file not found: ${videoPath}`);
  process.exit(1);
}

if (!fs.existsSync(clientSecretsPath)) {
  console.error(`[ERROR] OAuth client secrets file not found: ${clientSecretsPath}`);
  console.error('[ERROR] Create a Google Cloud OAuth Desktop client and save the JSON at that path.');
  process.exit(1);
}

if (!['private', 'unlisted', 'public'].includes(privacyStatus)) {
  console.error(`[ERROR] Invalid privacy value: ${privacyStatus}`);
  process.exit(1);
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
  const secrets = loadClientSecrets(clientSecretsPath);
  const redirectUri = resolveRedirectUri(secrets);
  const redirectUrl = new URL(redirectUri);
  const listenHost = redirectUrl.hostname === 'localhost' ? '127.0.0.1' : redirectUrl.hostname;
  const listenPort = Number(redirectUrl.port || 80);
  const oauth2Client = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    redirectUri,
  );

  if (fs.existsSync(tokenPath)) {
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
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
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`[INFO] Saved OAuth token to ${tokenPath}`);
  return oauth2Client;
}

async function main() {
  const auth = await getAuthenticatedClient();
  const youtube = google.youtube({ version: 'v3', auth });

  console.log(`[INFO] Uploading ${videoPath}`);
  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(videoPath),
    },
  });

  if (!response.data.id) {
    throw new Error('Upload completed without returning a video ID');
  }

  console.log(JSON.stringify({
    videoId: response.data.id,
    title,
    privacyStatus,
    url: `https://www.youtube.com/watch?v=${response.data.id}`,
  }, null, 2));
}

main().catch((error) => {
  console.error('[ERROR]', error.message || error);
  process.exit(1);
});