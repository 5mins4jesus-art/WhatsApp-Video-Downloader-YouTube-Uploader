#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const POST_LOG = path.join(process.cwd(), 'youtube_post_log.json');

const args = process.argv.slice(2);
const LIST_ONLY = args.includes('--list');
const ALL_UNAVAILABLE = args.includes('--all-unavailable');
const batchIds = collectFlagValues(args, '--batch-id');

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

function printUsage() {
    console.log('Usage: node reconcile_youtube_image_posts.mjs [--list] [--all-unavailable] [--batch-id <id> ...]');
    console.log('');
    console.log('Moves published image post batches back to a retry state without losing their original publish history.');
    console.log('Use --list to show current retry candidates.');
    console.log('Use --all-unavailable to reset every published batch whose postUrl is currently unavailable.');
    console.log('Use --batch-id to reset specific batches manually.');
}

if (args.includes('--help') || args.includes('-h')) {
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

function saveJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function isUnavailable(entry) {
    return entry?.verification?.urlStatus === 'unavailable';
}

function ensureRetryHistory(entry) {
    if (!Array.isArray(entry.publishHistory)) {
        entry.publishHistory = [];
    }
}

function resetEntryForRetry(entry, reason) {
    ensureRetryHistory(entry);

    entry.publishHistory.push({
        postUrl: entry.postUrl || null,
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

function main() {
    const log = loadJson(POST_LOG, { posts: [] });
    const posts = Array.isArray(log.posts) ? log.posts : [];

    if (LIST_ONLY) {
        const retryCandidates = posts.filter((entry) => isUnavailable(entry) || entry.status === 'retry-manual-publish');
        if (!retryCandidates.length) {
            console.log('No retry candidates found.');
            return;
        }

        for (const entry of retryCandidates) {
            console.log(`${entry.batchId} | status=${entry.status} | verification=${entry.verification?.urlStatus || 'unknown'} | reason=${entry.retryReason || 'n/a'}`);
        }
        return;
    }

    const selected = new Set(batchIds);
    let updated = 0;

    for (const entry of posts) {
        const shouldReset =
            (ALL_UNAVAILABLE && isUnavailable(entry) && entry.status === 'published') ||
            (selected.has(entry.batchId) && entry.status === 'published');

        if (!shouldReset) {
            continue;
        }

        const reason = isUnavailable(entry)
            ? 'Recorded post URL verified as unavailable'
            : 'Manually selected for retry';

        resetEntryForRetry(entry, reason);
        updated += 1;
        console.log(`Reset batch for retry: ${entry.batchId}`);
    }

    if (!updated) {
        console.log('No batches were reset.');
        return;
    }

    saveJson(POST_LOG, log);
    console.log(`Updated ${updated} batch(es).`);
}

main();