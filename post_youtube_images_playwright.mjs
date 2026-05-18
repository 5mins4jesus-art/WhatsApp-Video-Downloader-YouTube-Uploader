#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { spawn } from 'child_process';

const workspaceDir = process.cwd();
const POST_LOG = path.join(workspaceDir, 'youtube_post_log.json');
const AUTH_DIR = path.join(workspaceDir, '.playwright-youtube-auth');
const CHANNEL_POSTS_URL = 'https://www.youtube.com/@5m4jesus/posts';
const DEBUG_DIR = path.join(workspaceDir, 'watch_debug');

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
    console.log('Usage: node post_youtube_images_playwright.mjs [--batch-id <id> | --next] [--include-retry] [--mark-verified] [--headless]');
    console.log('');
    console.log('Posts a queued YouTube image batch using the visible Add an image composer flow in YouTube.');
    console.log('Requires an already signed-in YouTube browser session in Playwright persistent storage.');
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

async function captureComposerDebug(page, label) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    const screenshotPath = path.join(DEBUG_DIR, `youtube_posts_${safeLabel}.png`);
    const htmlPath = path.join(DEBUG_DIR, `youtube_posts_${safeLabel}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) {
        fs.writeFileSync(htmlPath, html, 'utf8');
    }

    const url = page.url();
    const title = await page.title().catch(() => '[unavailable]');
    throw new Error(`Unable to reach YouTube image composer at ${url} (${title}). Debug saved to ${screenshotPath}`);
}

async function waitForComposer(page) {
    const addImageButton = page.getByRole('button', { name: 'Add an image' }).first();
    await addImageButton.waitFor({ timeout: 20000 });
    await addImageButton.click();
    await page.getByText('Drag up to 10 images or GIFs or select from your computer').waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Post' }).last().waitFor({ timeout: 20000 });
}

async function ensurePostsComposerReady(page) {
    await page.goto(CHANNEL_POSTS_URL, { waitUntil: 'domcontentloaded' });

    const addImageButton = page.getByRole('button', { name: 'Add an image' }).first();
    if (await addImageButton.isVisible().catch(() => false)) {
        return;
    }

    const directPostButton = page.getByRole('button', { name: /^post$/i }).first();
    if (await directPostButton.isVisible().catch(() => false)) {
        return;
    }

    const createButton = page.getByRole('button', { name: /create/i }).first();
    if (await createButton.isVisible().catch(() => false)) {
        await createButton.click();
        if (await addImageButton.isVisible().catch(() => false)) {
            return;
        }
    }

    const sharePrompt = page.getByRole('button', { name: /share a behind-the-scenes photo/i }).first();
    if (await sharePrompt.isVisible().catch(() => false)) {
        await sharePrompt.click();
        if (await addImageButton.isVisible().catch(() => false)) {
            return;
        }
    }

    const imageLabel = page.getByText(/^image$/i).first();
    if (await imageLabel.isVisible().catch(() => false)) {
        return;
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    try {
        await Promise.race([
            addImageButton.waitFor({ timeout: 20000 }),
            directPostButton.waitFor({ timeout: 20000 }),
            imageLabel.waitFor({ timeout: 20000 }),
        ]);
    } catch {
        await captureComposerDebug(page, 'composer_not_found');
    }
}

async function attachImages(page, manifest) {
    const fileInput = page.locator('input[type="file"][accept="image/*"]').locator('nth=0');
    const filePaths = (manifest.images || []).map((image) => image.filepath);
    if (!filePaths.length) {
        throw new Error(`Batch ${manifest.batchId} has no images.`);
    }
    await fileInput.setInputFiles(filePaths);
    await page.getByRole('button', { name: 'Delete' }).waitFor({ timeout: 30000 });
}

async function fillPostText(page, text) {
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    await editor.fill(text);
}

async function submitPost(page) {
    const postButton = page.getByRole('button', { name: 'Post' }).last();
    await postButton.waitFor({ timeout: 20000 });
    await postButton.click();
    await page.getByText('Post created').waitFor({ timeout: 20000 });
}

async function getVisiblePostUrls(page) {
    const links = page.locator('a[href^="/post/"]');
    const count = await links.count();
    const urls = [];

    for (let index = 0; index < count; index += 1) {
        const href = await links.nth(index).getAttribute('href');
        if (!href) {
            continue;
        }
        urls.push(href.startsWith('http') ? href : `https://www.youtube.com${href}`);
    }

    return [...new Set(urls)];
}

async function getNewestPostUrl(page, previousUrls = []) {
    const previousUrlSet = new Set(previousUrls);

    await page.waitForFunction(
        ({ knownUrls }) => {
            const anchors = Array.from(document.querySelectorAll('a[href^="/post/"]'));
            return anchors.some((anchor) => {
                const href = anchor.getAttribute('href');
                if (!href) {
                    return false;
                }
                const absoluteUrl = href.startsWith('http') ? href : `https://www.youtube.com${href}`;
                return !knownUrls.includes(absoluteUrl);
            });
        },
        { knownUrls: [...previousUrlSet] },
        { timeout: 30000 },
    );

    const currentUrls = await getVisiblePostUrls(page);
    const newUrl = currentUrls.find((url) => !previousUrlSet.has(url));
    if (!newUrl) {
        throw new Error('Unable to locate new post URL after publishing.');
    }
    return newUrl;
}

async function main() {
    if (hasFlag('--help') || hasFlag('-h')) {
        printUsage();
        return;
    }

    const includeRetry = hasFlag('--include-retry');
    const requestedBatchId = getFlagValue('--batch-id');
    const shouldMarkVerified = hasFlag('--mark-verified');
    const headless = hasFlag('--headless');

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

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const context = await chromium.launchPersistentContext(AUTH_DIR, {
        headless,
        channel: 'chrome',
    });

    try {
        const page = context.pages()[0] || await context.newPage();
        await ensurePostsComposerReady(page);
        const previousPostUrls = await getVisiblePostUrls(page);

        await waitForComposer(page);
        await attachImages(page, manifest);
        await fillPostText(page, manifest.text);
        await submitPost(page);

        const postUrl = await getNewestPostUrl(page, previousPostUrls);
        console.log(`[OK] Created YouTube image post: ${postUrl}`);

        if (shouldMarkVerified) {
            await runNodeScript('process_image_post_queue.mjs', [
                '--batch-id',
                entry.batchId,
                '--mark-verified',
                postUrl,
                '--verify-retry-count',
                '3',
                '--verify-retry-delay-seconds',
                '15',
                '--mark-retry-if-unavailable',
                '--browser-confirmed',
                '--allow-browser-confirmed',
            ]);
        } else {
            console.log(`[INFO] Mark verified with: node process_image_post_queue.mjs --batch-id "${entry.batchId}" --mark-verified "${postUrl}" --verify-retry-count 3 --verify-retry-delay-seconds 15 --mark-retry-if-unavailable --browser-confirmed --allow-browser-confirmed`);
        }
    } finally {
        await context.close();
    }
}

main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
});