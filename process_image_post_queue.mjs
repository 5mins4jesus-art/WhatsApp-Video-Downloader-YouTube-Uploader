#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const workspaceDir = process.cwd();
const POST_LOG = path.join(workspaceDir, 'youtube_post_log.json');

const args = process.argv.slice(2);

function hasFlag(flag) {
    return args.includes(flag);
}

function getFlagValue(flag, fallback = null) {
    const index = args.indexOf(flag);
    if (index === -1) {
        return fallback;
    }
    return args[index + 1] ?? fallback;
}

function printUsage() {
    console.log('Usage: node process_image_post_queue.mjs [--next] [--batch-id <id>] [--mark-verified <postUrl>] [--include-retry] [--verify-retry-count 3] [--verify-retry-delay-seconds 15] [--mark-retry-if-unavailable] [--browser-confirmed] [--allow-browser-confirmed]');
    console.log('');
    console.log('Shows the next queued YouTube image post batch and optionally marks it published after URL verification.');
}

if (hasFlag('--help') || hasFlag('-h')) {
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

function runNodeScript(scriptName, scriptArgs = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(workspaceDir, scriptName), ...scriptArgs], {
            cwd: workspaceDir,
            stdio: 'inherit',
            env: process.env,
        });

        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`${scriptName} terminated by signal ${signal}`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`${scriptName} exited with code ${code}`));
                return;
            }
            resolve();
        });
    });
}

function getCandidateEntries(posts, includeRetry) {
    const allowedStatuses = includeRetry
        ? new Set(['pending-manual-publish', 'retry-manual-publish'])
        : new Set(['pending-manual-publish']);

    return posts
        .filter((entry) => allowedStatuses.has(entry?.status))
        .sort((left, right) => {
            const leftTime = Date.parse(left?.createdAt || '') || 0;
            const rightTime = Date.parse(right?.createdAt || '') || 0;
            return leftTime - rightTime;
        });
}

function loadManifest(entry) {
    if (!entry?.manifestPath || !fs.existsSync(entry.manifestPath)) {
        throw new Error(`Manifest missing for batch ${entry?.batchId || '[unknown]'}`);
    }
    return loadJson(entry.manifestPath, null);
}

function printBatch(manifest, entry) {
    console.log('========================================');
    console.log('Next YouTube Image Post Batch');
    console.log('========================================');
    console.log(`Batch ID: ${manifest.batchId}`);
    console.log(`Status: ${entry.status}`);
    console.log(`Chat: ${manifest.chatName}`);
    console.log(`Images: ${manifest.imageCount}`);
    console.log(`Manifest: ${entry.manifestPath}`);
    console.log('');
    console.log('Title:');
    console.log(manifest.title);
    console.log('');
    console.log('Text:');
    console.log(manifest.text);
    console.log('');
    console.log('Files:');
    for (const image of manifest.images || []) {
        console.log(image.filepath);
    }
}

async function main() {
    const includeRetry = hasFlag('--include-retry');
    const requestedBatchId = getFlagValue('--batch-id');
    const markVerifiedUrl = getFlagValue('--mark-verified');
    const verifyRetryCount = getFlagValue('--verify-retry-count');
    const verifyRetryDelaySeconds = getFlagValue('--verify-retry-delay-seconds');
    const markRetryIfUnavailable = hasFlag('--mark-retry-if-unavailable');
    const browserConfirmed = hasFlag('--browser-confirmed');
    const allowBrowserConfirmed = hasFlag('--allow-browser-confirmed');
    const log = loadJson(POST_LOG, { posts: [] });
    const posts = Array.isArray(log.posts) ? log.posts : [];

    let entry = null;
    if (requestedBatchId) {
        entry = posts.find((item) => item.batchId === requestedBatchId) || null;
        if (!entry) {
            throw new Error(`Batch not found: ${requestedBatchId}`);
        }
    } else {
        entry = getCandidateEntries(posts, includeRetry)[0] || null;
    }

    if (!entry) {
        console.log('[INFO] No queued image post batches found.');
        return;
    }

    const manifest = loadManifest(entry);
    if (!manifest) {
        throw new Error(`Unable to parse manifest for batch ${entry.batchId}`);
    }

    printBatch(manifest, entry);

    if (markVerifiedUrl) {
        console.log('');
        console.log('[STEP] Verifying and marking batch as published...');
        const verifyArgs = [entry.batchId, markVerifiedUrl];
        if (verifyRetryCount) {
            verifyArgs.push('--retry-count', verifyRetryCount);
        }
        if (verifyRetryDelaySeconds) {
            verifyArgs.push('--retry-delay-seconds', verifyRetryDelaySeconds);
        }
        if (markRetryIfUnavailable) {
            verifyArgs.push('--mark-retry-if-unavailable');
        }
        if (browserConfirmed) {
            verifyArgs.push('--browser-confirmed');
        }
        if (allowBrowserConfirmed) {
            verifyArgs.push('--allow-browser-confirmed');
        }
        await runNodeScript('mark_youtube_post_verified.mjs', verifyArgs);
    } else {
        console.log('');
        console.log('[INFO] After publishing this batch on YouTube, run:');
        console.log(`node process_image_post_queue.mjs --batch-id "${entry.batchId}" --mark-verified "<postUrl>" --verify-retry-count 3 --verify-retry-delay-seconds 15 --mark-retry-if-unavailable --browser-confirmed --allow-browser-confirmed`);
    }
}

main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
});