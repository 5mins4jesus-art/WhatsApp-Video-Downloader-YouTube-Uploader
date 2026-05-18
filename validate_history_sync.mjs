#!/usr/bin/env node
/**
 * Validate WhatsApp history sync using persisted auth state.
 * Prints the most recent processed history entries currently known to Baileys.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const authFolder = path.join(os.homedir(), '.local', 'share', 'mudslide');
const credsPath = path.join(authFolder, 'creds.json');

if (!fs.existsSync(credsPath)) {
  console.error(`Missing creds file: ${credsPath}`);
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
const history = creds.processedHistoryMessages || [];

if (history.length === 0) {
  console.log('No processed history messages found in auth state yet.');
  process.exit(2);
}

const recent = history.slice(-10).reverse();
console.log(`Processed history entries: ${history.length}`);
for (const entry of recent) {
  const jid = entry.key?.remoteJid || 'unknown';
  const id = entry.key?.id || 'unknown';
  const ts = entry.messageTimestamp
    ? new Date(Number(entry.messageTimestamp) * 1000).toLocaleString()
    : 'unknown time';
  console.log(`[${ts}] chat=${jid} messageId=${id}`);
}
