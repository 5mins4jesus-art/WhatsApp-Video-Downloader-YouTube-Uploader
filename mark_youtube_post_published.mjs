#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const POST_LOG = path.join(process.cwd(), 'youtube_post_log.json');

const args = process.argv.slice(2);
const batchId = args[0];
const postUrl = args[1] || null;

function printUsage() {
    console.log('Usage: node mark_youtube_post_published.mjs <batchId> [postUrl]');
}

if (!batchId || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(batchId ? 0 : 1);
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

const log = loadJson(POST_LOG, { posts: [] });
const entry = (log.posts || []).find((item) => item.batchId === batchId);

if (!entry) {
    console.error(`Batch not found: ${batchId}`);
    process.exit(1);
}

entry.status = 'published';
entry.publishedAt = new Date().toISOString();
if (postUrl) {
    entry.postUrl = postUrl;
}

saveJson(POST_LOG, log);
console.log(`Marked batch as published: ${batchId}`);