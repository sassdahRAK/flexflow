// Loads the inline application script from FlexFlow.html inside a node:vm
// context with just enough DOM/browser stubs for the module-level code and the
// pure helpers to run. No network access and no filesystem writes.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_PATH = path.resolve(HERE, '../../FlexFlow.html');
export const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

export function readAppSource() {
    return fs.readFileSync(APP_PATH, 'utf8');
}

/**
 * Extracts every inline (no `src`) script body from the HTML.
 * @returns {{body: string, attrs: string}[]}
 */
export function extractInlineScripts(html) {
    const out = [];
    INLINE_SCRIPT_RE.lastIndex = 0;
    let match;
    while ((match = INLINE_SCRIPT_RE.exec(html)) !== null) {
        if (/\bsrc\s*=/i.test(match[1])) continue;
        out.push({ attrs: match[1], body: match[2] });
    }
    return out;
}

export function extractAppScript(html = readAppSource()) {
    const inline = extractInlineScripts(html);
    if (inline.length !== 1) {
        throw new Error('Expected exactly one inline <script>, found ' + inline.length);
    }
    return inline[0].body;
}

function makeClassList() {
    const set = new Set();
    return {
        add(...names) { names.forEach(n => set.add(String(n))); },
        remove(...names) { names.forEach(n => set.delete(String(n))); },
        toggle(name, force) {
            const key = String(name);
            const on = force === undefined ? !set.has(key) : !!force;
            if (on) set.add(key); else set.delete(key);
            return on;
        },
        contains(name) { return set.has(String(name)); },
        replace(a, b) { if (set.has(a)) { set.delete(a); set.add(b); } return true; }
    };
}

function makeElement(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        id: '',
        className: '',
        innerHTML: '',
        textContent: '',
        value: '',
        hidden: false,
        checked: false,
        disabled: false,
        dataset: {},
        style: {},
        classList: makeClassList(),
        children: [],
        parentNode: null,
        isConnected: true,
        setAttribute() {},
        getAttribute() { return null; },
        removeAttribute() {},
        hasAttribute() { return false; },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
        appendChild(child) { if (child) { this.children.push(child); child.parentNode = this; } return child; },
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i >= 0) this.children.splice(i, 1);
            if (child) child.parentNode = null;
            return child;
        },
        insertBefore(child) { return this.appendChild(child); },
        append() {},
        remove() {},
        replaceChildren() {},
        focus() {},
        blur() {},
        click() {},
        play() { return Promise.resolve(); },
        pause() {},
        load() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        matches() { return false; },
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; },
        getContext() {
            return {
                drawImage() {}, fillRect() {}, clearRect() {}, save() {}, restore() {},
                translate() {}, rotate() {}, scale() {}, beginPath() {}, arc() {},
                fill() {}, stroke() {}, closePath() {},
                getImageData() { return { data: [] }; }, putImageData() {}
            };
        },
        toDataURL() { return 'data:image/png;base64,'; },
        scrollIntoView() {},
        setPointerCapture() {},
        releasePointerCapture() {}
    };
    return el;
}

function makeStorage() {
    const map = new Map();
    return {
        getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
        setItem(key, value) { map.set(String(key), String(value)); },
        removeItem(key) { map.delete(String(key)); },
        clear() { map.clear(); },
        key(index) { return Array.from(map.keys())[index] || null; },
        get length() { return map.size; }
    };
}

const EXPORTS = `
;globalThis.__flexflow = {
    SAFE_ID_RE: SAFE_ID_RE,
    RESERVED_ID_KEYS: RESERVED_ID_KEYS,
    STORAGE_KEYS: {
        tasks: TASKS_KEY,
        notes: QUICK_NOTES_KEY,
        changeLog: CHANGE_LOG_KEY,
        artists: ARTISTS_KEY
    },
    safeId: safeId,
    uniqueId: uniqueId,
    escapeHtml: escapeHtml,
    escapeJsArg: escapeJsArg,
    cssEscape: cssEscape,
    sanitizeCoverUrl: sanitizeCoverUrl,
    sanitizeImportedTask: sanitizeImportedTask,
    sanitizeImportedNotes: sanitizeImportedNotes,
    normaliseArtist: normaliseArtist,
    normaliseSlot: normaliseSlot,
    validateBackup: validateBackup,
    rehydrateBackup: rehydrateBackup,
    readZipBuffer: readZipBuffer,
    inspectBackupEntries: inspectBackupEntries,
    putBackupEntry: putBackupEntry,
    replayChangeOps: replayChangeOps,
    qnBubbleHtml: qnBubbleHtml,
    applyImport: applyImport,
    // Render functions touch the DOM. Tests that exercise persistence can
    // replace them inside the same lexical scope.
    stubRenderFns: function () {
        renderApp = function () {};
        renderQuickNotes = function () {};
        renderSettingsMeta = function () {};
        loadTasks = function () {};
        loadQuickNotes = function () {};
        sortCardsByTime = function () {};
    }
};
`;

/**
 * Loads FlexFlow.html's inline script into an isolated vm context.
 * @returns {{api: object, storage: object, html: string, script: string}}
 */
export function loadApp(options = {}) {
    const html = options.html || readAppSource();
    const script = extractAppScript(html);
    const storage = makeStorage();
    const elements = new Map();

    const documentStub = {
        body: makeElement('body'),
        documentElement: makeElement('html'),
        head: makeElement('head'),
        activeElement: null,
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
        createElement(tag) { return makeElement(tag); },
        createElementNS(_ns, tag) { return makeElement(tag); },
        createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
        getElementById(id) {
            const key = String(id);
            if (!elements.has(key)) elements.set(key, makeElement('div'));
            return elements.get(key);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };

    const windowStub = {
        isSecureContext: false,
        location: { protocol: 'https:', href: 'https://flexflow.local/' },
        addEventListener() {},
        removeEventListener() {},
        scrollTo() {},
        matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout,
        setInterval() { return 0; },
        clearInterval() {},
        indexedDB: undefined,
        MediaRecorder: undefined,
        URL,
        Blob
    };

    const sandbox = {
        console,
        document: documentStub,
        window: windowStub,
        self: windowStub,
        location: windowStub.location,
        navigator: { userAgent: 'node', share: undefined, canShare: undefined, mediaDevices: undefined, geolocation: undefined },
        localStorage: storage,
        sessionStorage: makeStorage(),
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        Blob,
        File,
        atob,
        btoa,
        setTimeout,
        clearTimeout,
        setInterval() { return 0; },
        clearInterval() {},
        queueMicrotask,
        requestAnimationFrame() { return 0; },
        cancelAnimationFrame() {},
        CSS: {
            escape(value) {
                return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch.codePointAt(0).toString(16) + ' ');
            }
        },
        Image: function Image() { return makeElement('img'); },
        crypto: globalThis.crypto
    };

    const context = vm.createContext(sandbox);
    vm.runInContext(script + EXPORTS, context, { filename: APP_PATH });
    const api = sandbox.__flexflow;
    if (!api) throw new Error('App script did not export __flexflow');
    return { api, storage, html, script, context, document: documentStub };
}

/** Decodes the HTML entities that escapeHtml emits. */
export function decodeHtml(value) {
    return String(value)
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}
