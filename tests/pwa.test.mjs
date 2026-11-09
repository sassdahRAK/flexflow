// Hermetic static tests for the FlexFlow installable-PWA support layer.
// Run with: node --test tests/pwa.test.mjs
//
// These are plain file assertions: no browser, no vm sandbox, no network.
// They pin the manifest, the icon assets, the service worker precache list
// and the PWA wiring inside FlexFlow.html to the file-based reality of the
// repo, so a broken install/offline path fails a test instead of shipping.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const THEME = '#F2F2F7';

const readText = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const exists = name => fs.existsSync(path.join(ROOT, name));

/** Maps a root-relative web path to its on-disk path. */
function diskPathFor(url) {
    assert.ok(url.startsWith('/'), `${url} must be a root-relative path`);
    assert.ok(!url.startsWith('//'), `${url} must not be protocol-relative`);
    assert.ok(!/^[a-z]+:/i.test(url), `${url} must not carry a scheme`);
    // The app shell is served at '/' but lives in FlexFlow.html on disk
    // (Vercel cleanUrls serves FlexFlow.html for '/').
    const relative = url === '/' ? 'FlexFlow.html' : url.replace(/^\/+/, '');
    return path.join(ROOT, relative);
}

/** Reads PNG magic bytes and IHDR dimensions, failing loudly otherwise. */
function pngInfo(file) {
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length >= 24, `${file} is too short to be a PNG`);
    assert.deepEqual(
        Array.from(bytes.subarray(0, 8)),
        Array.from(PNG_MAGIC),
        `${file} must start with the PNG signature`
    );
    // IHDR width/height live at byte offsets 16 and 20.
    return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20)
    };
}

function parseSize(sizes) {
    const match = /^(\d+)x(\d+)$/.exec(String(sizes || ''));
    assert.ok(match, `unparseable manifest sizes value: ${sizes}`);
    return { width: Number(match[1]), height: Number(match[2]) };
}

/** Extracts every quoted string from the sw.js PRECACHE array literal. */
function parsePrecache(source) {
    const block = /const\s+PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(source);
    assert.ok(block, 'sw.js must declare a PRECACHE array');
    const urls = [];
    const re = /['"]([^'"]+)['"]/g;
    let match;
    while ((match = re.exec(block[1])) !== null) urls.push(match[1]);
    assert.ok(urls.length > 0, 'PRECACHE must not be empty');
    return urls;
}

// ---------- manifest ----------

test('manifest.webmanifest parses with the required install metadata', () => {
    assert.ok(exists('manifest.webmanifest'), 'manifest.webmanifest must exist');
    const manifest = JSON.parse(readText('manifest.webmanifest'));

    assert.equal(manifest.name, 'FlexFlow');
    assert.equal(manifest.short_name, 'FlexFlow');
    assert.equal(manifest.id, '/');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.background_color, THEME);
    assert.equal(manifest.theme_color, THEME);
    assert.equal(manifest.lang, 'en');
    assert.ok(Array.isArray(manifest.icons), 'icons must be an array');
});

test('manifest icons cover 192/512 any-purpose and a maskable 512', () => {
    const manifest = JSON.parse(readText('manifest.webmanifest'));
    const icons = manifest.icons;

    const find = (width, height, purpose) => icons.find(icon => {
        const size = parseSize(icon.sizes);
        return size.width === width && size.height === height && icon.purpose === purpose;
    });

    assert.ok(find(192, 192, 'any'), 'a 192x192 any-purpose icon is required');
    assert.ok(find(512, 512, 'any'), 'a 512x512 any-purpose icon is required');
    assert.ok(find(512, 512, 'maskable'), 'a 512x512 maskable icon is required');
});

test('every manifest icon resolves to a PNG of its declared dimensions', () => {
    const manifest = JSON.parse(readText('manifest.webmanifest'));
    assert.ok(manifest.icons.length > 0, 'the manifest must list at least one icon');

    for (const icon of manifest.icons) {
        assert.equal(icon.type, 'image/png', `${icon.src} must be declared as image/png`);
        const file = diskPathFor(icon.src);
        assert.ok(fs.existsSync(file), `${icon.src} must exist on disk`);

        const info = pngInfo(file);
        const declared = parseSize(icon.sizes);
        assert.equal(info.width, declared.width, `${icon.src} width must match ${icon.sizes}`);
        assert.equal(info.height, declared.height, `${icon.src} height must match ${icon.sizes}`);
    }
});

test('the apple-touch-icon is a 180x180 PNG', () => {
    const file = path.join(ROOT, 'icons', 'apple-touch-icon.png');
    assert.ok(fs.existsSync(file), 'icons/apple-touch-icon.png must exist');
    const info = pngInfo(file);
    assert.equal(info.width, 180, 'the apple-touch-icon must be 180px wide');
    assert.equal(info.height, 180, 'the apple-touch-icon must be 180px tall');
});

// ---------- service worker ----------

test('sw.js declares the shell cache, lifecycle listeners and a valid script', () => {
    assert.ok(exists('sw.js'), 'sw.js must exist');
    const source = readText('sw.js');

    assert.match(source, /CACHE_NAME\s*=\s*['"]flexflow-shell-v1['"]/,
        'the shell cache must be named flexflow-shell-v1');
    assert.match(source, /addEventListener\(\s*['"]install['"]/,
        'sw.js must handle install');
    assert.match(source, /addEventListener\(\s*['"]activate['"]/,
        'sw.js must handle activate');
    assert.match(source, /addEventListener\(\s*['"]message['"]/,
        'sw.js must handle message');

    // Parsing the source as a function body catches syntax errors without
    // executing it or spawning a child process (also gated by `node --check`).
    assert.doesNotThrow(() => new Function(source), 'sw.js must parse as valid JavaScript');
});

test('every sw.js precache URL is a same-origin relative path that exists', () => {
    const urls = parsePrecache(readText('sw.js'));

    for (const url of urls) {
        assert.match(url, /^\/(?!\/)/, `${url} must be a root-relative path`);
        assert.doesNotMatch(url, /^[a-z]+:/i, `${url} must not be an absolute URL`);
        assert.doesNotMatch(url, /^\/\//, `${url} must not be protocol-relative`);
        const file = diskPathFor(url);
        assert.ok(fs.existsSync(file), `${url} -> ${path.relative(ROOT, file)} must exist`);
    }

    assert.ok(urls.includes('/'), 'PRECACHE must cache the app shell at /');
    assert.ok(urls.includes('/manifest.webmanifest'), 'PRECACHE must include the manifest');
    assert.ok(urls.includes('/icons/apple-touch-icon.png'),
        'PRECACHE must include the apple-touch-icon');

    // '/' is served from FlexFlow.html by cleanUrls; caching the raw file name
    // would create a second, unreachable shell entry.
    assert.ok(!urls.includes('/FlexFlow.html'),
        'PRECACHE must not include /FlexFlow.html (the shell is keyed at /)');
});

// ---------- FlexFlow.html wiring ----------

test('FlexFlow.html links the manifest and a 180x180 apple-touch-icon', () => {
    const html = readText('FlexFlow.html');

    assert.match(html, /<link\b[^>]*rel\s*=\s*["']manifest["'][^>]*>/i,
        'FlexFlow.html must declare rel="manifest"');
    assert.match(html, /href\s*=\s*["'][^"']*manifest\.webmanifest["']/,
        'FlexFlow.html must point the manifest link at manifest.webmanifest');

    const links = Array.from(html.matchAll(/<link\b[^>]*>/gi), match => match[0]);
    const apple = links.find(tag =>
        /rel\s*=\s*["']apple-touch-icon["']/i.test(tag) &&
        /sizes\s*=\s*["']180x180["']/i.test(tag) &&
        /icons\/apple-touch-icon\.png/i.test(tag)
    );
    assert.ok(apple, 'FlexFlow.html must link the 180x180 apple-touch-icon');
});

test('FlexFlow.html keeps exactly one inline <script> with no local src', () => {
    const html = readText('FlexFlow.html');
    const opens = Array.from(html.matchAll(/<script\b[^>]*>/gi), match => match[0]);
    const closes = (html.match(/<\/script\s*>/gi) || []).length;

    assert.equal(opens.length, 1, 'FlexFlow.html must contain exactly one <script> tag');
    assert.equal(closes, 1, 'the single <script> tag must be closed exactly once');

    for (const tag of opens) {
        assert.doesNotMatch(tag, /\bsrc\s*=/i,
            `the single script must be inline, not external (found: ${tag})`);
    }
});

test('the service worker registration is feature- and protocol-guarded', () => {
    const html = readText('FlexFlow.html');

    const guard = /function\s+pwaWorkerSupported\s*\(\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(html);
    assert.ok(guard, 'a pwaWorkerSupported() guard function is required');
    const guardBody = guard[1];

    assert.match(guardBody, /['"]serviceWorker['"]\s+in\s+navigator/,
        "the guard must test 'serviceWorker' in navigator");
    assert.match(guardBody, /location\.protocol\s*===\s*['"]http:['"]/,
        'the guard must accept http: (localhost development)');
    assert.match(guardBody, /location\.protocol\s*===\s*['"]https:['"]/,
        'the guard must accept https:');
    assert.doesNotMatch(guardBody, /['"]file:['"]/,
        'the guard must not treat file: as service-worker capable');

    assert.match(html, /navigator\.serviceWorker\.register\(\s*['"]\/sw\.js['"]/,
        'FlexFlow.html must register /sw.js');

    // The registration must sit behind the guard, not run unconditionally.
    const guardCall = html.search(/if\s*\(\s*pwaWorkerSupported\s*\(\s*\)\s*\)/);
    const register = html.search(/navigator\.serviceWorker\.register\(/);
    assert.ok(guardCall >= 0, 'initPwa() must gate registration on pwaWorkerSupported()');
    assert.ok(register > guardCall,
        'the registration must live inside the pwaWorkerSupported() branch');
});
