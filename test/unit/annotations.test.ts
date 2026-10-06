// The `note` backend: append and read annotations.ndjson.
import { describe, expect, it } from 'vitest';
import { StError } from '../../src/core/errors.js';
import { layout } from '../../src/store/layout.js';
import { addAnnotation, readAnnotations } from '../../src/sources/annotations.js';
import { fixedClock, manualClock, memoryStore } from '../helpers/index.js';

describe('annotations', () => {
  it('appends normalised notes and reads them back in order', async () => {
    const store = memoryStore();
    const clock = manualClock('2026-10-06T06:17:00.123Z');
    const a = await addAnnotation(store, { date: '2026-09-09', text: '  New title   template ', urls: ['https://Example.com/b#x', 'https://example.com/a', 'https://example.com/a'], field: 'title' }, clock);
    expect(a).toMatchObject({ at: '2026-10-06T06:17:00Z', date: '2026-09-09', text: 'New title template', urls: ['https://example.com/a', 'https://example.com/b'], field: 'title' });
    expect(a.id).toMatch(/^a[a-z2-7]{15}$/);
    clock.advance(60_000);
    const b = await addAnnotation(store, { date: '2026-09-20', text: 'Moved the blog', urls: ['https://example.com/blog/'], field: 'annotation' }, clock);
    expect(await readAnnotations(store)).toEqual([a, b]);
    const raw = await store.readFile(layout.annotations);
    expect(raw?.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('skips a torn last line and malformed records', async () => {
    const store = memoryStore();
    const a = await addAnnotation(store, { date: '2026-09-09', text: 'One', urls: [], field: 'annotation' }, fixedClock('2026-10-01T00:00:00Z'));
    await store.writeFileAtomic(layout.annotations, `${(await store.readFile(layout.annotations)) ?? ''}{"id":"x","date":"not a date"}\n{"id":"torn`);
    expect(await readAnnotations(store)).toEqual([a]);
    const b = await addAnnotation(store, { date: '2026-09-10', text: 'Two', urls: [], field: 'annotation' }, fixedClock('2026-10-02T00:00:00Z'));
    expect(await readAnnotations(store)).toEqual([a, b]);
  });

  it('refuses bad input with a config error and a fix line', async () => {
    const store = memoryStore();
    const clock = fixedClock('2026-10-01T00:00:00Z');
    const bad = [
      { date: '2026-13-01', text: 'x', urls: [], field: 'title' as const },
      { date: '2026-09-01', text: '   ', urls: [], field: 'title' as const },
      { date: '2026-09-01', text: 'x', urls: ['/relative/path'], field: 'title' as const },
      { date: '2026-09-01', text: 'x'.repeat(501), urls: [], field: 'title' as const },
    ];
    for (const a of bad) {
      const err = await addAnnotation(store, a, clock).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StError);
      expect((err as StError).code).toBe('config');
      expect((err as StError).fix).toBeTruthy();
    }
    expect(await readAnnotations(store)).toEqual([]);
  });

  it('returns nothing when there is no file', async () => {
    expect(await readAnnotations(memoryStore())).toEqual([]);
  });
});
