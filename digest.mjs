import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const __dir = dirname(fileURLToPath(import.meta.url));
const p = (f) => join(__dir, f);

const cfg = yaml.load(readFileSync(p('config.yml'), 'utf8'));
const statePath = p('state.json');
let state;
try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
catch { state = { last_sent: null, versions: {} }; }

const FORCE = process.env.FORCE === 'true';     // bypass cadence (manual runs)
const DRY_RUN = process.env.DRY_RUN === 'true'; // build but do not send or write state

const now = new Date();
const cadenceMs = (cfg.cadence_days ?? 14) * 86400000;

function isDue() {
  if (FORCE) return true;
  if (!state.last_sent) return true;
  return (now - new Date(state.last_sent)) >= cadenceMs;
}

if (!isDue()) {
  const days = Math.floor((now - new Date(state.last_sent)) / 86400000);
  console.log(`Not due (${days}/${cfg.cadence_days} days since last send). Exiting.`);
  process.exit(0);
}

// Versions are "new" if published after this point. First run looks back one cadence.
const windowStart = state.last_sent ? new Date(state.last_sent) : new Date(now - cadenceMs);

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

async function npmTimes(pkg) {
  const r = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  if (!r.ok) throw new Error(`npm ${pkg} -> ${r.status}`);
  const j = await r.json();
  return j.time || {};
}

function cmpVer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

// Gather new versions and changelog text per source
const sourceData = [];
for (const s of cfg.sources) {
  const times = await npmTimes(s.npm_package);
  const versions = Object.entries(times)
    .filter(([v]) => v !== 'created' && v !== 'modified')
    .filter(([, t]) => new Date(t) > windowStart)
    .map(([v, t]) => ({ version: v, date: t.slice(0, 10) }))
    .sort((a, b) => cmpVer(a.version, b.version));
  const changelog = await fetchText(s.changelog);
  sourceData.push({ ...s, versions, changelog });
}

const totalNew = sourceData.reduce((n, s) => n + s.versions.length, 0);
console.log(`New versions in window: ${totalNew}`);

const dateStr = now.toLocaleDateString(cfg.language || 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const subject = (cfg.subject || 'Claude Code digest ({date})').replace('{date}', dateStr);

let bodyHtml = null, bodyText = null, sent = false;

if (totalNew === 0) {
  if (cfg.empty_digest === 'skip') {
    console.log('Nothing new and empty_digest=skip. Advancing state, no email.');
  } else {
    bodyText = `No major Claude Code updates in the last ${cfg.cadence_days} days.`;
    bodyHtml = `<p>${bodyText}</p>`;
  }
} else {
  const content = await summarise(sourceData);
  if (cfg.format === 'markdown') {
    bodyText = content;
    bodyHtml = `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(content)}</pre>`;
  } else {
    bodyHtml = content;
    bodyText = stripHtml(content);
  }
}

if ((bodyHtml || bodyText) && !DRY_RUN) {
  await sendEmail(subject, bodyHtml, bodyText);
  sent = true;
} else if (DRY_RUN) {
  console.log('DRY_RUN — not sending. Preview:\n', bodyHtml || bodyText || '(nothing)');
}

// Advance state so cadence resets and the next run starts after these versions
state.last_sent = now.toISOString();
for (const s of sourceData) {
  if (s.versions.length) state.versions[s.npm_package] = s.versions[s.versions.length - 1].version;
}
if (!DRY_RUN) writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
console.log(`Done. sent=${sent} dry_run=${DRY_RUN}`);

async function summarise(sources) {
  const filterRule = {
    major: 'only MAJOR new functionalities (new commands, modes, agent or workflow capabilities, models, sandboxing, MCP, integrations, skills and plugins). Exclude bug fixes and minor tweaks.',
    all: 'all new features and functionalities, excluding pure bug fixes.',
    everything: 'all changes including bug fixes and reliability improvements.'
  }[cfg.filter || 'major'];

  const maxItems = cfg.max_items && cfg.max_items > 0 ? ` Limit to the ${cfg.max_items} most significant items.` : '';
  const group = cfg.group_by_theme ? ' Group items by theme with a short heading per group.' : '';
  const fmt = cfg.format === 'markdown'
    ? 'Output GitHub-flavoured Markdown.'
    : 'Output a self-contained HTML fragment only (no html, head or body tags). Use h2 for theme headings and ul/li for items, with minimal inline styling.';

  const parts = sources.map(s => {
    const vlist = s.versions.map(v => `${v.version} (${v.date})`).join(', ');
    return `## Source: ${s.name}\nVersions to cover: ${vlist}\n\nCHANGELOG:\n${s.changelog}`;
  }).join('\n\n---\n\n');

  const prompt = `You are compiling an email digest of new releases for: ${sources.map(s => s.name).join(', ')}.

Cover ONLY the versions listed under "Versions to cover" in each source. From those versions, extract ${filterRule}${maxItems}${group}

For each item, give a one-line description plus the version number it appeared in and its release date. Write in ${cfg.language || 'en-GB'} using UK spelling. Avoid filler words. Do not use em dashes or semicolons. ${fmt}

End with a single line stating the version range covered.

${parts}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: cfg.model || 'claude-opus-4-8',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.content.map(b => b.text || '').join('').trim();
}

async function sendEmail(subject, html, text) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [process.env.EMAIL_TO],
      subject,
      html: html || undefined,
      text: text || undefined
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  console.log('Email sent.');
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function stripHtml(s) { return s.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim(); }
