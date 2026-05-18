#!/usr/bin/env node
/**
 * Quick diagnostic: list all available WhatsApp chats after history sync
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import P from 'pino';

const AUTH_FOLDER = path.join(os.homedir(), '.local', 'share', 'mudslide');

async function main() {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Baileys version: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })) },
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['Chrome (Linux)', '', ''],
        syncFullHistory: true,
    });

    sock.ev.on('creds.update', saveCreds);

    // Wait for connection open
    await new Promise((resolve, reject) => {
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed, reconnecting:', shouldReconnect);
                if (shouldReconnect) {
                    resolve(await main());
                } else {
                    reject(new Error('Logged out'));
                }
            } else if (connection === 'open') {
                console.log('✅ Connected to WhatsApp!');
                resolve();
            }
        });
    });

    // Wait for history sync - give it time
    console.log('Waiting 15 seconds for history sync...');
    await new Promise(r => setTimeout(r, 15000));

    // List groups
    console.log('\n=== GROUPS ===');
    try {
        const groups = await sock.groupFetchAllParticipating();
        if (groups && groups.length > 0) {
            for (const g of groups) {
                console.log(`  - "${g.subject}" -> ${g.id}`);
            }
            console.log(`Total groups: ${groups.length}`);
        } else {
            console.log('  No groups found or groups is not iterable:', typeof groups, groups);
        }
    } catch (err) {
        console.log('  Error fetching groups:', err.message);
    }

    // List contacts from store
    console.log('\n=== CONTACTS (from sock.store) ===');
    try {
        if (sock.store?.contacts) {
            const contacts = sock.store.contacts;
            let count = 0;
            for (const [jid, contact] of Object.entries(contacts)) {
                const name = contact.name || contact.notify || '(no name)';
                if (name !== '(no name)') {
                    console.log(`  - "${name}" -> ${jid}`);
                    count++;
                }
            }
            console.log(`Total named contacts: ${count}`);
        } else {
            console.log('  sock.store.contacts not available');
        }
    } catch (err) {
        console.log('  Error reading contacts:', err.message);
    }

    // List chats from store
    console.log('\n=== CHATS (from sock.store) ===');
    try {
        if (sock.store?.chats) {
            const chats = sock.store.chats;
            let count = 0;
            for (const [jid, chat] of Object.entries(chats)) {
                const name = chat.name || '(no name)';
                console.log(`  - "${name}" -> ${jid} (conv: ${chat.conversationTimestamp || 'n/a'})`);
                count++;
            }
            console.log(`Total chats: ${count}`);
        } else {
            console.log('  sock.store.chats not available');
        }
    } catch (err) {
        console.log('  Error reading chats:', err.message);
    }

    // Also try using mudslide to list chats
    console.log('\n=== MUDSLIDE CHATS ===');
    try {
        const { execSync } = await import('child_process');
        const result = execSync('npx mudslide chats 2>&1', { encoding: 'utf-8', timeout: 30000 });
        console.log(result);
    } catch (err) {
        console.log('  Error:', err.message);
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
