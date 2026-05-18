#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const target = process.argv[2];
const forceCapture = process.argv.includes('--force-capture');
const HISTORY_CACHE_MAX_AGE_MS = Number.parseInt(process.env.HISTORY_CACHE_MAX_AGE_MS || String(6 * 60 * 60 * 1000), 10);

if (!target) {
    console.error('Usage: node watch_messages.mjs <jid-or-group-name>');
    process.exit(1);
}

const DEBUG_DIR = path.join(process.cwd(), 'watch_debug');

function sanitizeDebugName(value) {
    return value.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'watch';
}

function getHistoryDebugFile(targetValue) {
    return path.join(DEBUG_DIR, `${sanitizeDebugName(targetValue)}.messaging_history_set.jsonl`);
}

function listHistoryDebugFiles() {
    if (!fs.existsSync(DEBUG_DIR)) {
        return [];
    }

    return fs.readdirSync(DEBUG_DIR)
        .filter((name) => name.endsWith('.messaging_history_set.jsonl'))
        .map((name) => path.join(DEBUG_DIR, name));
}

function isFreshNonEmptyFile(filePath) {
    try {
        const stats = fs.statSync(filePath);
        if (stats.size <= 0) {
            return false;
        }
        return (Date.now() - stats.mtimeMs) <= HISTORY_CACHE_MAX_AGE_MS;
    } catch {
        return false;
    }
}

function hasCachedHistory(targetValue) {
    if (forceCapture) {
        return false;
    }

    const historyFile = getHistoryDebugFile(targetValue);
    if (!fs.existsSync(historyFile)) {
        if (!targetValue.includes('@')) {
            return false;
        }

        return listHistoryDebugFiles().some((filePath) => {
            try {
                if (!isFreshNonEmptyFile(filePath)) {
                    return false;
                }
                return fs.readFileSync(filePath, 'utf8').includes(`"remoteJid":"${targetValue}"`);
            } catch {
                return false;
            }
        });
    }

    return isFreshNonEmptyFile(historyFile);
}

if (hasCachedHistory(target)) {
    console.log(`[INFO] Historic metadata already cached for "${target}".`);
    console.log(`[INFO] Reusing ${path.relative(process.cwd(), getHistoryDebugFile(target))} and exiting.`);
    process.exit(0);
}

const forwardedArgs = ['download_and_upload.mjs', '--capture-only'];
if (forceCapture) {
    forwardedArgs.push('--force-capture');
}
if (target.includes('@')) {
    forwardedArgs.push('--chat-jids', target);
} else {
    forwardedArgs.push('--chats', target);
}

const child = spawn(process.execPath, forwardedArgs, {
    stdio: 'inherit',
    env: process.env,
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 0);
});