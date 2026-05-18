#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const POST_LOG = path.join(process.cwd(), 'youtube_post_log.json');

const args = process.argv.slice(2);
const batchId = args[0];
const postUrl = args[1] || null;
const retryDelaySeconds = Number.parseInt(getFlagValue('--retry-delay-seconds', '0'), 10) || 0;
const retryCount = Number.parseInt(getFlagValue('--retry-count', '0'), 10) || 0;
const markRetryIfUnavailable = args.includes('--mark-retry-if-unavailable');
const allowBrowserConfirmed = args.includes('--allow-browser-confirmed');
const browserConfirmed = args.includes('--browser-confirmed');

function getFlagValue(flag, fallback = null) {
    const index = args.indexOf(flag);
    if (index === -1) {
        return fallback;
    }
    return args[index + 1] ?? fallback;
}

function printUsage() {
    console.log('Usage: node mark_youtube_post_verified.mjs <batchId> <postUrl> [--retry-count 3] [--retry-delay-seconds 15] [--mark-retry-if-unavailable] [--browser-confirmed] [--allow-browser-confirmed]');
}

if (!batchId || !postUrl || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(batchId && postUrl ? 0 : 1);
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

function saveJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function ensureRetryHistory(entry) {
    if (!Array.isArray(entry.publishHistory)) {
        entry.publishHistory = [];
    }
}

function resetEntryForRetry(entry, reason, postUrlValue) {
    ensureRetryHistory(entry);
    entry.publishHistory.push({
        postUrl: postUrlValue || entry.postUrl || null,
        publishedAt: entry.publishedAt || null,
        previousStatus: entry.status || null,
        resetAt: new Date().toISOString(),
        reason,
    });

    entry.status = 'retry-manual-publish';
    entry.retryReason = reason;
    entry.retryMarkedAt = new Date().toISOString();
    delete entry.postUrl;
    delete entry.publishedAt;
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkUrl(url) {
    const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
    });

    const body = await response.text();
    const unavailable = /This post is unavailable|Video unavailable|404 Not Found|Page not found/i.test(body);

    return {
        ok: response.ok && !unavailable,
        status: response.status,
        finalUrl: response.url,
        unavailable,
    };
}

async function main() {
    const log = loadJson(POST_LOG, { posts: [] });
    const entry = (log.posts || []).find((item) => item.batchId === batchId);

    if (!entry) {
        throw new Error(`Batch not found: ${batchId}`);
    }

    let result = await checkUrl(postUrl);
    for (let attempt = 0; attempt < retryCount && !result.ok; attempt += 1) {
        if (retryDelaySeconds > 0) {
            console.log(`[INFO] Verification retry ${attempt + 1}/${retryCount} in ${retryDelaySeconds}s for ${postUrl}`);
            await wait(retryDelaySeconds * 1000);
        }
        result = await checkUrl(postUrl);
    }

    entry.verification = {
        checkedAt: new Date().toISOString(),
        urlStatus: result.ok ? 'available' : 'unavailable',
        httpStatus: result.status || null,
        finalUrl: result.finalUrl || postUrl,
        error: null,
    };

    if (!result.ok) {
        if (browserConfirmed && allowBrowserConfirmed) {
            entry.status = 'published';
            entry.publishedAt = new Date().toISOString();
            entry.postUrl = result.finalUrl || postUrl;
            entry.verification.urlStatus = 'browser-confirmed';
            entry.verification.browserConfirmed = true;
            entry.verification.browserConfirmedAt = new Date().toISOString();
            delete entry.retryReason;
            delete entry.retryMarkedAt;
            saveJson(POST_LOG, log);
            console.log(`Marked batch as published after browser-confirmed verification: ${batchId}`);
            return;
        }
        if (markRetryIfUnavailable) {
            resetEntryForRetry(entry, 'Newly created post URL remained unavailable after verification retries', postUrl);
        }
        saveJson(POST_LOG, log);
        throw new Error(`Refusing to mark batch as published because the post URL is unavailable: ${postUrl}`);
    }

    entry.status = 'published';
    entry.publishedAt = new Date().toISOString();
    entry.postUrl = result.finalUrl || postUrl;
    delete entry.retryReason;
    delete entry.retryMarkedAt;

    saveJson(POST_LOG, log);
    console.log(`Marked batch as published after verification: ${batchId}`);
}

main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
});