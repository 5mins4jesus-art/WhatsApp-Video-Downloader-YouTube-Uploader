#!/usr/bin/env node

import path from 'path';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';

const { Client, LocalAuth } = pkg;

const SESSION_DIR = path.join(process.cwd(), '.wwebjs_auth');
const WEB_CACHE_DIR = path.join(process.cwd(), '.wwebjs_cache');
const WWEBJS_CLIENT_ID = 'history-list';
const args = process.argv.slice(2);
const LOGIN_IF_NEEDED = args.includes('--login-if-needed');

function buildClient() {
    return new Client({
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
}

async function main() {
    const client = buildClient();
    let resolved = false;

    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!resolved) {
                    reject(new Error('Timed out waiting for WhatsApp Web auth state'));
                }
            }, 120000);

            client.on('qr', (qr) => {
                if (!LOGIN_IF_NEEDED) {
                    clearTimeout(timeout);
                    resolved = true;
                    reject(new Error('WhatsApp Web login required'));
                    return;
                }

                console.log('[INFO] WhatsApp login required. Scan this QR code:');
                qrcode.generate(qr, { small: true });
            });

            client.once('ready', async () => {
                clearTimeout(timeout);
                resolved = true;
                const state = await client.getState().catch(() => 'UNKNOWN');
                console.log(`[OK] WhatsApp Web authenticated. State: ${state}`);
                resolve();
            });

            client.once('auth_failure', (message) => {
                clearTimeout(timeout);
                resolved = true;
                reject(new Error(`WhatsApp Web auth failure: ${message}`));
            });

            client.initialize().catch((error) => {
                clearTimeout(timeout);
                resolved = true;
                reject(error);
            });
        });
    } finally {
        try {
            await client.destroy();
        } catch {
        }
    }
}

main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
});