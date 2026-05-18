#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const POST_LOG = path.join(process.cwd(), 'youtube_post_log.json');

const args = process.argv.slice(2);
const CHECK_URLS = args.includes('--check-urls');
const STRICT = args.includes('--strict');

function printUsage() {
    console.log('Usage: node verify_youtube_image_posts.mjs [--check-urls] [--strict]');
    console.log('');
    console.log('Verifies youtube_post_log.json consistency for image post batches.');
    console.log('Use --check-urls to also fetch each recorded post URL and confirm it resolves.');
    console.log('Use --strict to exit non-zero on any warning, not just hard failures.');
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

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
}

function isBrowserConfirmedPublished(entry) {
    return entry?.status === 'published'
        && entry?.verification?.browserConfirmed === true
        && entry?.verification?.urlStatus === 'browser-confirmed';
}

async function checkUrl(url) {
    try {
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
    } catch (error) {
        return {
            ok: false,
            error: error.message,
        };
    }
}

async function main() {
    const log = loadJson(POST_LOG, { posts: [] });
    const posts = Array.isArray(log.posts) ? log.posts : [];

    if (!posts.length) {
        console.error('[FAIL] No post entries found in youtube_post_log.json');
        process.exit(1);
    }

    let failures = 0;
    let warnings = 0;
    const seenBatchIds = new Set();
    const seenMessageIds = new Map();

    console.log(`[INFO] Verifying ${posts.length} image post batch entries`);

    for (const entry of posts) {
        const label = entry.batchId || '[missing batchId]';

        if (!entry.batchId) {
            console.error('[FAIL] Entry missing batchId');
            failures += 1;
            continue;
        }

        if (seenBatchIds.has(entry.batchId)) {
            console.error(`[FAIL] Duplicate batchId detected: ${entry.batchId}`);
            failures += 1;
        }
        seenBatchIds.add(entry.batchId);

        if (!Array.isArray(entry.messageIds) || !entry.messageIds.length) {
            console.error(`[FAIL] ${label} has no messageIds`);
            failures += 1;
        }

        for (const messageId of entry.messageIds || []) {
            if (!messageId) {
                console.error(`[FAIL] ${label} contains an empty messageId`);
                failures += 1;
                continue;
            }
            const previousBatch = seenMessageIds.get(messageId);
            if (previousBatch && previousBatch !== entry.batchId) {
                console.error(`[FAIL] messageId reused across batches: ${messageId}`);
                console.error(`       first batch: ${previousBatch}`);
                console.error(`       second batch: ${entry.batchId}`);
                failures += 1;
            } else {
                seenMessageIds.set(messageId, entry.batchId);
            }
        }

        if (!entry.manifestPath || !fs.existsSync(entry.manifestPath)) {
            console.error(`[FAIL] ${label} manifest missing: ${entry.manifestPath || '[missing path]'}`);
            failures += 1;
        }

        if (entry.status !== 'published') {
            console.warn(`[WARN] ${label} status is ${entry.status || '[missing]'}`);
            warnings += 1;
        }

        if (entry.status === 'published' && !entry.publishedAt) {
            console.warn(`[WARN] ${label} is published but missing publishedAt`);
            warnings += 1;
        }

        if (entry.status === 'published' && !isHttpUrl(entry.postUrl)) {
            console.warn(`[WARN] ${label} is published but missing a valid postUrl`);
            warnings += 1;
        }

        if (CHECK_URLS && isHttpUrl(entry.postUrl) && !isBrowserConfirmedPublished(entry)) {
            const result = await checkUrl(entry.postUrl);
            entry.verification = {
                checkedAt: new Date().toISOString(),
                urlStatus: result.ok ? 'available' : 'unavailable',
                httpStatus: result.status || null,
                finalUrl: result.finalUrl || entry.postUrl,
                error: result.error || null,
            };
            if (result.ok) {
                console.log(`[OK] ${label} -> ${result.finalUrl} (${result.status})`);
            } else {
                console.error(`[FAIL] ${label} URL check failed: ${entry.postUrl}`);
                if (result.status) {
                    console.error(`       HTTP status: ${result.status}`);
                }
                if (result.error) {
                    console.error(`       Error: ${result.error}`);
                }
                if (result.unavailable) {
                    console.error('       Page content indicates the post is unavailable');
                }
                failures += 1;
            }
        } else if (CHECK_URLS && isBrowserConfirmedPublished(entry)) {
            console.log(`[OK] ${label} -> browser-confirmed in authenticated channel UI`);
        }
    }

    if (CHECK_URLS) {
        fs.writeFileSync(POST_LOG, JSON.stringify(log, null, 2));
    }

    console.log(`[INFO] Verification complete. Failures: ${failures}. Warnings: ${warnings}.`);

    if (failures > 0 || (STRICT && warnings > 0)) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(`[FATAL] ${error.message}`);
    process.exit(1);
});