#!/usr/bin/env node
/**
 * WhatsApp Login Script using Baileys directly
 * Fixed version: only requests pairing code once, handles reconnection properly
 * 
 * Usage:
 *   node whatsapp_login.mjs                    # QR code login
 *   node whatsapp_login.mjs --pairing-code     # Pairing code login (will prompt for phone)
 *   node whatsapp_login.mjs --pairing-code 14163020588  # With phone number
 */

import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import readline from 'readline';

const AUTH_FOLDER = process.env.MUDSLIDE_CACHE_FOLDER || `${process.env.HOME}/.local/share/mudslide`;

const args = process.argv.slice(2);
const usePairingCode = args.includes('--pairing-code');
const phoneIdx = args.indexOf('--pairing-code');
const phoneNumber = phoneIdx !== -1 && args[phoneIdx + 1] && !args[phoneIdx + 1].startsWith('--') 
  ? args[phoneIdx + 1] 
  : null;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

let pairingCodeRequested = false;
let loginComplete = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 0; // 0 = unlimited retries

async function connect() {
  console.log('[INFO] WhatsApp Login via Baileys');
  console.log(`[INFO] Auth folder: ${AUTH_FOLDER}`);
  console.log(`[INFO] Method: ${usePairingCode ? 'Pairing Code' : 'QR Code'}`);
  
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[INFO] Baileys version: ${version.join('.')}`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
    },
    logger: P({ level: 'silent' }),
    browser: ['Chrome (Linux)', '', ''],
    syncFullHistory: true,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    qrTimeout: 120000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    // Handle QR code display manually (printQRInTerminal is deprecated)
    if (qr && !usePairingCode) {
      console.log('\n[INFO] Scan this QR code with your WhatsApp app:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n[INFO] WhatsApp > Settings > Connected Devices > Connect Device\n');
    }
    
    if (qr && usePairingCode && !pairingCodeRequested) {
      pairingCodeRequested = true;
      let phone = phoneNumber;
      if (!phone) {
        phone = await ask('Enter phone number (E.164 format, no + sign, e.g. 14163020588): ');
      }
      phone = phone.replace(/[^0-9]/g, '');
      console.log(`[INFO] Requesting pairing code for: ${phone}`);
      
      try {
        const code = await sock.requestPairingCode(phone);
        console.log('\n╔══════════════════════════════════════╗');
        console.log(`║   YOUR PAIRING CODE: ${code}            ║`);
        console.log('╠══════════════════════════════════════╣');
        console.log('║   On your phone:                     ║');
        console.log('║   1. Open WhatsApp                   ║');
        console.log('║   2. Settings > Connected Devices    ║');
        console.log('║   3. Connect Device                  ║');
        console.log('║   4. Link with phone number          ║');
        console.log(`║   5. Enter: ${code}                   ║`);
        console.log('╚══════════════════════════════════════╝\n');
        console.log('[INFO] Waiting for you to enter the code (2 min timeout)...\n');
      } catch (err) {
        console.error('[ERROR] Failed to request pairing code:', err.message);
        pairingCodeRequested = false;
      }
    }
    
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[INFO] Connection closed. Code: ${code}`);

      if (code === DisconnectReason.loggedOut) {
        console.log('[ERROR] Logged out. Please run again.');
        rl.close();
        process.exit(1);
      }

      if (loginComplete) return;

        // 428 = temporary ban (rate limited) — wait longer before retrying (unlimited retries)
        if (code === 428) {
            reconnectAttempts++;
            const waitSeconds = Math.min(30 * reconnectAttempts, 300);
            console.log(`[WARN] Rate limited (428). Waiting ${waitSeconds}s before retry ${reconnectAttempts}...`);
            console.log('[INFO] Tip: Scan the QR code quickly when it appears — it expires in ~60s!');
            pairingCodeRequested = false;
            setTimeout(() => {
                connect().catch(console.error);
            }, waitSeconds * 1000);
            return;
        }

        if (code === 408 || code === 401) {
            console.log('[WARN] Connection timed out or unauthorized. Reconnecting...');
            pairingCodeRequested = false;
            setTimeout(() => {
                connect().catch(console.error);
            }, 10000);
            return;
        }

        // Other disconnect reasons — try reconnecting with backoff (unlimited retries)
        reconnectAttempts++;
        console.log(`[INFO] Reconnecting (attempt ${reconnectAttempts})...`);
        pairingCodeRequested = false;
        setTimeout(() => {
            connect().catch(console.error);
        }, 5000);
    } else if (connection === 'open') {
      loginComplete = true;
      console.log('\n╔══════════════════════════════════════╗');
      console.log('║  ✅ CONNECTED TO WHATSAPP!           ║');
      console.log('╠══════════════════════════════════════╣');
      console.log('║  Auth credentials saved.             ║');
      console.log('║  History sync starting...            ║');
      console.log('║  You can now run download script.    ║');
      console.log('╚══════════════════════════════════════╝\n');
      
      setTimeout(() => {
        console.log('[INFO] Login complete. Exiting...');
        rl.close();
        process.exit(0);
      }, 10000);
    }
  });
}

connect().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
