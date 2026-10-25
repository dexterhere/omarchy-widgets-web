import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../../scripts/build-registry';
import {
  LAYOUT_LIMITS,
  bindsOf,
  checkBindings,
  validateLayout,
  validateSampleData,
  type LayoutNode
} from '../../src/lib/registry/layout';
import {
  codeWidgetJson,
  layoutJson,
  listing,
  manifestJson,
  mockFetch,
  noFixture,
  noReview,
  widgetJson
} from './registry.helpers';

const b = { topic: 'github.prs', field: 'open' };
const lay = (root: unknown, extra = {}) => ({ schemaVersion: 0, root, ...extra });
const errs = (v: unknown, variants: string[] = []) => {
  const r = validateLayout(v, variants);
  return r.ok ? [] : r.errors;
};

describe('validateLayout', () => {
  it('accepts every fixture layout', () => {
    for (const d of readdirSync('tests/fixtures/widgets')) {
      const l = JSON.parse(readFileSync(`tests/fixtures/widgets/${d}/layout.json`, 'utf8'));
      const w = JSON.parse(readFileSync(`tests/fixtures/widgets/${d}/widget.json`, 'utf8'));
      expect(errs(l, w.variants), d).toEqual([]);
    }
  });
  it.each([
    ['unknown node', lay({ type: 'script', src: 'x' }), /not a known node/],
    ['extra property', lay({ type: 'divider', onclick: 'x' }), /unknown property/],
    ['raw colour', lay({ type: 'value', bind: b, color: '#ff0000' }), /never a colour/],
    ['css colour name', lay({ type: 'value', bind: b, color: 'red' }), /role/],
    ['url in text', lay({ type: 'text', text: '<img src=x onerror=1>' }), /plain text/],
    ['bidi in text', lay({ type: 'text', text: 'a‮b' }), /plain text/],
    ['text and bind', lay({ type: 'text', text: 'x', bind: b }), /exactly one/],
    ['long text', lay({ type: 'text', text: 'x'.repeat(121) }), /plain text/],
    ['bad bind', lay({ type: 'value', bind: { topic: 'a b', field: 'x' } }), /invalid topic/],
    [
      'bind extra key',
      lay({ type: 'value', bind: { ...b, expr: '1+1' } }),
      /must be \{topic, field\}/
    ],
    ['bad icon', lay({ type: 'icon', name: 'http://x' }), /icon/],
    ['list too long', lay({ type: 'list', bind: b, max: 51 }), /max/],
    ['empty stack', lay({ type: 'stack', children: [] }), /children/],
    ['wrong version', { schemaVersion: 1, root: { type: 'divider' } }, /schemaVersion/],
    [
      'proto key',
      JSON.parse('{"schemaVersion":0,"root":{"type":"divider"},"__proto__x":1}'),
      /unknown property/
    ],
    ['not an object', [], /object/]
  ])('rejects %s', (_n, v, re) => expect(errs(v).join()).toMatch(re));
  it('rejects too deep and too many nodes', () => {
    let n: unknown = { type: 'divider' };
    for (let i = 0; i < LAYOUT_LIMITS.depth; i++) n = { type: 'stack', children: [n] };
    expect(errs(lay(n)).join()).toMatch(/deeper/);
    const wide = { type: 'stack', children: Array(20).fill({ type: 'divider' }) };
    const tree = { type: 'stack', children: Array(11).fill(wide) };
    expect(errs(lay(tree)).join()).toMatch(/more than 200 nodes/);
  });
  it('variants must be declared', () => {
    const v = lay({ type: 'divider' }, { variants: { digital: { type: 'divider' } } });
    expect(errs(v, ['digital'])).toEqual([]);
    expect(errs(v, ['analog']).join()).toMatch(/not declared/);
  });
  it('does not treat inherited names as nodes', () =>
    expect(errs(lay({ type: 'constructor' })).join()).toMatch(/not a known node/));
});

describe('sample data and bindings', () => {
  const sd = { 'github.prs': { open: 3, titles: ['a', 'b'], series: [1, 2, 3] } };
  const node = (type: string, field: string) => ({ type, bind: { topic: 'github.prs', field } });
  const prov = [{ topics: ['github.prs'], fields: ['open', 'titles', 'series'] }];
  it('accepts matching shapes', () => {
    expect(validateSampleData(sd)).toEqual([]);
    expect(
      checkBindings(
        [node('ring', 'open'), node('list', 'titles'), node('sparkline', 'series')],
        prov,
        sd
      )
    ).toEqual([]);
  });
  it('rejects undeclared, missing and wrongly shaped bindings', () => {
    expect(checkBindings([node('ring', 'secret')], prov, sd).join()).toMatch(/not declared/);
    expect(
      checkBindings(
        [node('ring', 'open')],
        [{ topics: ['github.prs'], fields: ['open'] }],
        {}
      ).join()
    ).toMatch(/no sampleData/);
    expect(checkBindings([node('ring', 'titles')], prov, sd).join()).toMatch(/wrong shape/);
    expect(checkBindings([node('sparkline', 'open')], prov, sd).join()).toMatch(/wrong shape/);
  });
  it.each([
    [{ 'github.prs': { open: NaN } }],
    [{ 'github.prs': { open: Infinity } }],
    [{ 'github.prs': { open: 'x'.repeat(121) } }],
    [{ 'github.prs': { open: '<b>x</b>' } }],
    [{ 'github.prs': { open: [1, 'a'] } }],
    [{ 'github.prs': { open: Array(51).fill(1) } }],
    [{ 'bad topic': { open: 1 } }],
    [[]]
  ])('rejects hostile sample data %#', (v) =>
    expect(validateSampleData(v).length).toBeGreaterThan(0)
  );
  it('bindsOf lists every binding', () => {
    const n = {
      type: 'stack',
      children: [node('ring', 'open'), { type: 'row', children: [node('list', 'titles')] }]
    } as LayoutNode;
    expect(bindsOf(n).map((x) => x.type)).toEqual(['ring', 'list']);
  });
});

describe('build integration', () => {
  const run = (widget: object, layout: unknown) =>
    buildRegistry({
      listings: [{ file: 'io.github.someone.demo.json', data: listing() }],
      fetch: mockFetch({
        'manifest.json': manifestJson(),
        'widget.json': widget,
        'layout.json': layout
      }).fn,
      skipReachability: true,
      readFixture: noFixture,
      readReview: noReview
    });
  it('carries layout and sampleData into the output', async () => {
    const r = await run(widgetJson(), layoutJson());
    expect(r.errors).toEqual([]);
    expect(r.widgets[0].layout?.root.type).toBe('value');
    expect(r.widgets[0].sampleData).toEqual({ 'github.prs': { open: 3 } });
  });
  it('excludes a widget whose layout binds an undeclared field', async () => {
    const bad = layoutJson({
      root: { type: 'value', bind: { topic: 'github.prs', field: 'token' } }
    });
    const r = await run(widgetJson(), bad);
    expect(r.widgets).toEqual([]);
    expect(r.errors.join()).toMatch(/bindings/);
  });
  it('excludes a spec widget without layout.json and one with hostile text', async () => {
    expect((await run(widgetJson(), null)).errors.length).toBe(1);
    const hostile = layoutJson({ root: { type: 'text', text: '<script>alert(1)</script>' } });
    expect((await run(widgetJson(), hostile)).errors.join()).toMatch(/HTML|plain/);
  });
  it('code widgets get no layout; layout.json is fetched only to be hashed', async () => {
    const m = mockFetch({
      'manifest.json': manifestJson(),
      'widget.json': codeWidgetJson()
    });
    const r = await buildRegistry({
      listings: [{ file: 'io.github.someone.demo.json', data: listing() }],
      fetch: m.fn,
      skipReachability: true,
      readFixture: noFixture,
      readReview: noReview
    });
    expect(r.errors).toEqual([]);
    expect(r.widgets[0].layout).toBeNull();
    // `ow install` fetches and checks all three files, so the index must hash all three.
    expect(Object.keys(r.widgets[0].sha256 ?? {}).sort()).toEqual([
      'layout.json',
      'manifest.json',
      'widget.json'
    ]);
  });
});
