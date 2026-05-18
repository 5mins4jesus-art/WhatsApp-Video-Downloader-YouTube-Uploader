#!/usr/bin/env node

import fs from 'fs';
import http from 'http';
import path from 'path';
import { google } from 'googleapis';
import open from 'open';

const args = process.argv.slice(2);
const LOGIN_IF_NEEDED = args.includes('--login-if-needed');
const clientSecretsPath = path.join(process.cwd(), 'youtube_client_secret.json');
const tokenPath = path.join(process.cwd(), 'youtube_oauth_token.json');
const REQUIRED_SCOPES = [
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/youtube.upload',
];

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
    const oauth2Client = new google.auth.OAuth2(
        secrets.client_id,
        secrets.client_secret,
        redirectUri,
    );

    async function runInteractiveLogin() {
        if (!LOGIN_IF_NEEDED) {
            throw new Error('YouTube login required');
        }

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: REQUIRED_SCOPES,
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
        const grantedScopes = scope.split(/\s+/).filter(Boolean);
        if (!REQUIRED_SCOPES.some((requiredScope) => grantedScopes.includes(requiredScope))) {
            if (!LOGIN_IF_NEEDED) {
                throw new Error('Authenticated token is missing youtube.upload or youtube.force-ssl scope');
            }
            console.log('[INFO] Existing YouTube token is missing required scope. Re-running interactive login.');
            fs.rmSync(tokenPath, { force: true });
            oauth2Client.setCredentials({});
            return runInteractiveLogin();
        }
        return oauth2Client;
    } catch (error) {
        const message = String(error?.message || error);
        if (!/invalid_grant/i.test(message) && !/missing youtube\.upload or youtube\.force-ssl scope/i.test(message)) {
            throw error;
        }

        console.log('[INFO] Existing YouTube token is invalid or missing required scope. Re-running interactive login.');
        fs.rmSync(tokenPath, { force: true });
        oauth2Client.setCredentials({});
        return runInteractiveLogin();
    }
}

async function main() {
    const auth = await getAuthenticatedClient();
    const accessToken = await auth.getAccessToken();
    const tokenValue = typeof accessToken === 'string' ? accessToken : accessToken?.token;
    if (!tokenValue) {
        throw new Error('Authenticated YouTube token could not be resolved');
    }

    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(tokenValue)}`);
    const tokenInfo = await response.json();

    if (!response.ok) {
        throw new Error(tokenInfo.error_description || tokenInfo.error || 'Failed to validate YouTube token');
    }

    const scope = String(tokenInfo.scope || '');
    const grantedScopes = scope.split(/\s+/).filter(Boolean);
    const matchedScope = REQUIRED_SCOPES.find((requiredScope) => grantedScopes.includes(requiredScope));
    if (!matchedScope) {
        throw new Error('Authenticated token is missing youtube.upload or youtube.force-ssl scope');
    }

    console.log(`[OK] YouTube authenticated with ${matchedScope} scope`);
}

main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
});