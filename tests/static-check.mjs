// Dependency-free static invariants for FlexFlow.html.
// Run with: node tests/static-check.mjs
//
// Exits 0 when the hardened file satisfies every invariant, nonzero otherwise.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { readAppSource, extractInlineScripts } from './lib/load-app.mjs';

const WRAPPERS = ['escapeHtml(', 'escapeJsArg(', 'cssEscape(', 'safeId('];
const SAFE_ID_FUNCTIONS = [
    'sanitizeImportedTask',
    'sanitizeImportedNotes',
    'normaliseArtist',
    'normaliseSlot'
];

function lineAt(src, index) {
    let line = 1;
    for (let i = 0; i < index && i < src.length; i++) {
        if (src[i] === '\n') line++;
    }
    return line;
}

function snippetAt(src, index) {
    const start = src.lastIndexOf('\n', index) + 1;
    const end = src.indexOf('\n', index);
    return src.slice(start, end < 0 ? undefined : end).trim();
}

/** Finds `${task.id}`-style interpolation not immediately wrapped by a sanitizer. */
export function findRawIdInterpolations(src) {
    const issues = [];
    const re = /\$\{((?:task|item|note|a|sl)\.id)\}/g;
    let match;
    while ((match = re.exec(src)) !== null) {
        const before = src.slice(0, match.index);
        const wrapped = WRAPPERS.some(wrapper => before.endsWith(wrapper));
        if (!wrapped) {
            issues.push({
                line: lineAt(src, match.index),
                message: `raw \${${match[1]}} interpolation; wrap it in escapeHtml/escapeJsArg/cssEscape/safeId`,
                snippet: snippetAt(src, match.index)
            });
        }
    }
    return issues;
}

/** Inline on*="..." handlers that interpolate anything must use escapeJsArg(). */
export function findUnsafeInlineHandlers(src) {
    const issues = [];
    const re = /\b(on[a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let match;
    while ((match = re.exec(src)) !== null) {
        const value = match[2] !== undefined ? match[2] : match[3];
        if (!value.includes('${')) continue;
        if (value.includes('escapeJsArg(')) continue;
        issues.push({
            line: lineAt(src, match.index),
            message: `inline ${match[1]} handler interpolates without escapeJsArg()`,
            snippet: snippetAt(src, match.index)
        });
    }
    return issues;
}

/** querySelector/querySelectorAll selectors must cssEscape any interpolated id. */
export function findUnsafeQuerySelectors(src) {
    const issues = [];
    const re = /\.querySelector(?:All)?\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")\s*\)/g;
    let match;
    while ((match = re.exec(src)) !== null) {
        const selector = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
        if (!selector.includes('${')) continue;
        if (!/\$\{[^}]*id[^}]*\}/i.test(selector)) continue;
        if (selector.includes('cssEscape(')) continue;
        issues.push({
            line: lineAt(src, match.index),
            message: 'querySelector selector interpolates an id without cssEscape()',
            snippet: snippetAt(src, match.index)
        });
    }
    return issues;
}

function skipQuoted(src, start) {
    const quote = src[start];
    let i = start + 1;
    while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) return i;
        i++;
    }
    return i;
}

/** Returns the full source text of a named function declaration, or null. */
export function findFunctionBody(src, name) {
    const signature = new RegExp('function\\s+' + name + '\\s*\\(');
    const match = signature.exec(src);
    if (!match) return null;
    let i = src.indexOf('{', match.index + match[0].length);
    if (i < 0) return null;
    let depth = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(src, i) + 1; continue; }
        if (ch === '/' && src[i + 1] === '/') {
            const nl = src.indexOf('\n', i);
            i = nl < 0 ? src.length : nl + 1;
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end < 0 ? src.length : end + 2;
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(match.index, i + 1);
        }
        i++;
    }
    return null;
}

/** Every import-facing normaliser must route ids through safeId. */
export function findSafeIdUsageIssues(src) {
    const issues = [];
    for (const name of SAFE_ID_FUNCTIONS) {
        const body = findFunctionBody(src, name);
        if (!body) {
            issues.push({ line: 0, message: `function ${name}() not found`, snippet: name });
            continue;
        }
        if (!body.includes('safeId(')) {
            const at = src.indexOf(body);
            issues.push({
                line: lineAt(src, at),
                message: `${name} does not call safeId()`,
                snippet: name
            });
        }
    }
    return issues;
}

function checkScripts(html) {
    const issues = [];
    const opens = Array.from(html.matchAll(/<script\b[^>]*>/gi));
    const closes = Array.from(html.matchAll(/<\/script\s*>/gi));
    if (opens.length !== closes.length) {
        issues.push({ line: 1, message: `unbalanced script tags (${opens.length} open, ${closes.length} close)`, snippet: '' });
    }
    const inline = extractInlineScripts(html);
    if (inline.length !== 1) {
        issues.push({ line: 1, message: `expected exactly one inline <script>, found ${inline.length}`, snippet: '' });
    }
    return { issues, script: inline.length === 1 ? inline[0].body : null };
}

function checkScriptSyntax(script) {
    if (!script) {
        return [{ line: 0, message: 'no inline script to parse', snippet: '' }];
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexflow-static-'));
    const tmp = path.join(dir, 'app-inline.js');
    try {
        fs.writeFileSync(tmp, script, 'utf8');
        execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
        return [];
    } catch (error) {
        const detail = error && error.stderr ? String(error.stderr).trim() : String(error && error.message || error);
        return [{ line: 0, message: 'extracted script failed node --check: ' + detail, snippet: '' }];
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function runSelfTests() {
    const issues = [];
    const cases = [
        {
            label: 'raw id interpolation is detected',
            issues: findRawIdInterpolations('const x = `${task.id}`;'),
            expectIssues: true
        },
        {
            label: 'wrapped id interpolation is accepted',
            issues: findRawIdInterpolations('const x = `${escapeHtml(task.id)}`;'),
            expectIssues: false
        },
        {
            label: 'inline handler without escapeJsArg is detected',
            issues: findUnsafeInlineHandlers('<button onclick="fn(${task.id})">'),
            expectIssues: true
        },
        {
            label: 'inline handler with escapeJsArg is accepted',
            issues: findUnsafeInlineHandlers('<button onclick="fn(${escapeJsArg(task.id)})">'),
            expectIssues: false
        },
        {
            label: 'querySelector without cssEscape is detected',
            issues: findUnsafeQuerySelectors('document.querySelector(`.card[data-id="${cardId}"]`)'),
            expectIssues: true
        },
        {
            label: 'querySelector with cssEscape is accepted',
            issues: findUnsafeQuerySelectors('document.querySelector(`.card[data-id="${cssEscape(cardId)}"]`)'),
            expectIssues: false
        }
    ];
    for (const c of cases) {
        const detected = c.issues.length > 0;
        if (detected !== c.expectIssues) {
            issues.push({ line: 0, message: 'self-test failed: ' + c.label, snippet: '' });
        }
    }
    return issues;
}

function main() {
    // FLEXFLOW_HTML lets a test harness point the checker at a mutated copy.
    const html = process.env.FLEXFLOW_HTML
        ? fs.readFileSync(path.resolve(process.env.FLEXFLOW_HTML), 'utf8')
        : readAppSource();
    const checks = [];

    const scripts = checkScripts(html);
    checks.push({ name: 'exactly one inline <script> with balanced tags', issues: scripts.issues });

    checks.push({ name: 'extracted inline script passes node --check', issues: checkScriptSyntax(scripts.script) });

    checks.push({ name: 'no raw ${task/item/note/a/sl.id} interpolation', issues: findRawIdInterpolations(html) });

    checks.push({ name: 'inline on*= handlers use escapeJsArg for interpolation', issues: findUnsafeInlineHandlers(html) });

    checks.push({ name: 'querySelector selectors use cssEscape for interpolated ids', issues: findUnsafeQuerySelectors(html) });

    checks.push({ name: 'safeId() is used by all import normalisers', issues: findSafeIdUsageIssues(html) });

    checks.push({ name: 'static-checker self-tests', issues: runSelfTests() });

    let failed = 0;
    console.log('FlexFlow static invariants');
    for (const check of checks) {
        if (check.issues.length === 0) {
            console.log('  PASS  ' + check.name);
            continue;
        }
        failed++;
        console.log('  FAIL  ' + check.name);
        for (const issue of check.issues) {
            const location = issue.line ? 'FlexFlow.html:' + issue.line + ' ' : '';
            console.log('        ' + location + issue.message);
            if (issue.snippet) console.log('          > ' + issue.snippet);
        }
    }
    console.log('');
    console.log(failed === 0 ? 'RESULT: PASS (' + checks.length + ' checks)' : 'RESULT: FAIL (' + failed + ' of ' + checks.length + ' checks)');
    process.exitCode = failed === 0 ? 0 : 1;
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) main();
