#!/usr/bin/env node
// Maintainer script: rebuild the "events" list in assets/google-updates-seed.json from Google's
// Search Status Dashboard history pages. Port of the original gen_seed.py. Not run in CI.
//
//   node scripts/gen-updates-seed.mjs            fetch and print what would change (writes nothing)
//   node scripts/gen-updates-seed.mjs --write    fetch and rewrite the seed file
//
// Google's live incidents.json only holds the 10 most recent incidents, so the seed carries the
// rest. Times on the incident pages are US/Pacific; they are converted to UTC here. The curated
// entries (reporting anomalies such as num=100) and every other top-level key are kept as they are.
import { readFileSync, writeFileSync } from 'node:fs';

const SEED = new URL('../assets/google-updates-seed.json', import.meta.url);
const ORIGIN = 'https://status.search.google.com';
const PRODUCTS = {
  Crawling: 'QAVfsAEBQ159b2mEWBYF',
  Indexing: 'DRyTdKyPd41QXD2hnncp',
  Ranking: 'rGHU1u87FJnkP6W2GwMi',
  Serving: 'pKUD9XkLn3TBLquSpQMD',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'searchtrace-seed/0.1' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.text();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
function textLines(html) {
  const stripped = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '\n');
  const decoded = stripped.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
  return decoded.split('\n').map((l) => l.trim()).filter(Boolean);
}

function kindFor(service, title) {
  if (service !== 'Ranking') return 'outage';
  const t = title.toLowerCase();
  if (t.includes('discover')) return 'discover';
  if (t.includes('core update')) return 'core';
  if (t.includes('spam')) return 'spam';
  return 'other_ranking';
}

const laFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function laWall(ms) {
  const p = Object.fromEntries(laFormat.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`;
}
/** 'YYYY-MM-DD HH:MM' in Pacific Time to 'YYYY-MM-DDTHH:MM:00Z'. */
function ptToUtc(wall) {
  if (!wall) return null;
  const [d, t] = wall.split(' ');
  const base = Date.parse(`${d}T${t}:00Z`);
  for (const hours of [7, 8]) {
    const ms = base + hours * 3_600_000;
    if (laWall(ms) === wall) return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  throw new Error(`Could not convert ${wall} from Pacific Time`);
}

async function main() {
  const write = process.argv.includes('--write');
  const seed = JSON.parse(readFileSync(SEED, 'utf8'));
  const events = [];
  for (const [service, id] of Object.entries(PRODUCTS)) {
    const history = await get(`${ORIGIN}/products/${id}/history`);
    const ids = [...new Set([...history.matchAll(/incidents\/([A-Za-z0-9]{20})/g)].map((m) => m[1]))];
    for (const iid of ids) {
      const lines = textLines(await get(`${ORIGIN}/incidents/${iid}`));
      const at = lines.indexOf(`Incident affecting ${service}`);
      const title = at >= 0 && lines[at + 1] ? lines[at + 1] : lines[3];
      const m = /Incident began at (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?: and ended at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}))?/.exec(lines.join(' '));
      if (!m || !title) {
        process.stderr.write(`could not parse ${iid}\n`);
        continue;
      }
      events.push({
        id: iid, source: 'seed', service, kind: kindFor(service, title), title,
        begin: ptToUtc(m[1]), end: ptToUtc(m[2] ?? null), url: `${ORIGIN}/incidents/${iid}`,
      });
      await sleep(300);
    }
  }
  events.sort((a, b) => (a.begin < b.begin ? 1 : a.begin > b.begin ? -1 : 0));

  const before = new Map(seed.events.map((e) => [e.id, JSON.stringify(e)]));
  const added = events.filter((e) => !before.has(e.id));
  const changed = events.filter((e) => before.has(e.id) && before.get(e.id) !== JSON.stringify(e));
  const gone = seed.events.filter((e) => !events.some((x) => x.id === e.id));
  process.stdout.write(`${events.length} incidents: ${added.length} new, ${changed.length} changed, ${gone.length} no longer listed\n`);
  for (const e of [...added, ...changed]) process.stdout.write(`  ${e.begin} ${e.kind} ${e.title}\n`);
  if (gone.length) process.stdout.write('Incidents no longer listed are kept out of the new file; check them by hand.\n');
  if (!write) {
    process.stdout.write('Nothing written. Run again with --write to update the seed.\n');
    return;
  }
  const next = { ...seed, generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), events };
  writeFileSync(SEED, JSON.stringify(next, null, 1));
  process.stdout.write(`Wrote ${SEED.pathname}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
