import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../../scripts/build-registry';
import { distance, report, runGate, type GateDeps } from '../../scripts/gate/run-gate';
import { ID, json, layoutJson, listing, manifestJson, widgetJson } from './registry.helpers';

const catalog = JSON.parse(readFileSync('registry/providers.json', 'utf8'));
const OWNER = 'someone';
const ent = (path: string, over = {}) => ({
  path,
  mode: '100644',
  type: 'blob',
  size: 10,
  ...over
});
const BASE_TREE = [
  ent('manifest.json'),
  ent('widget.json'),
  ent('layout.json'),
  ent('LICENSE'),
  ent('README.md')
];

interface Repo {
  files?: Record<string, unknown>;
  tree?: unknown[];
  truncated?: boolean;
  archived?: boolean;
  license?: string;
}
function repoFetch(r: Repo = {}): FetchFn {
  const files: Record<string, unknown> = {
    'manifest.json': manifestJson(),
    'widget.json': widgetJson({ capabilities: { network: [], files: [], spawn: [] } }),
    'layout.json': layoutJson(),
    LICENSE: 'MIT',
    'README.md': 'hello',
    ...r.files
  };
  return async (url) => {
    if (url.includes('/license')) return json({ license: { spdx_id: r.license ?? 'MIT' } });
    if (url.includes('/compare/')) return json({ status: 'behind' });
    if (url.includes('/git/trees/'))
      return json({ truncated: r.truncated ?? false, tree: r.tree ?? BASE_TREE });
    if (url.startsWith('https://api.github.com'))
      return json({
        default_branch: 'main',
        id: 1,
        owner: { id: 7 },
        archived: r.archived ?? false
      });
    const name = decodeURIComponent(url.split('/').slice(6).join('/'));
    if (!(name in files)) return new Response('no', { status: 404 });
    const v = files[name];
    return new Response(typeof v === 'string' ? v : JSON.stringify(v));
  };
}
const deps = (over: Partial<GateDeps> = {}): GateDeps => ({
  fetch: repoFetch(),
  lock: { [ID]: { repoId: 1, ownerId: 7 } },
  catalog,
  namespaces: {},
  reserved: { prefixes: ['omarchy.'] },
  retired: { ids: [] },
  existing: [],
  isMaintainer: false,
  ...over
});
const go = (r: Repo, d: Partial<GateDeps> = {}, l: object = listing()) =>
  runGate(`${(l as { id: string }).id}.json`, l, deps({ fetch: repoFetch(r), ...d }));
const errs = async (r: Repo, d: Partial<GateDeps> = {}, l: object = listing()) =>
  (await go(r, d, l)).errors.join('\n');

describe('gate matrix', () => {
  it('passes a clean spec widget', async () => {
    const r = await go({});
    expect(r.errors).toEqual([]);
  });
  it('a missing lock entry is a warning, not a failure', async () => {
    const r = await go({}, { lock: {} });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/lock\.json/);
  });
  it('a different repo id fails', async () => {
    expect(await errs({}, { lock: { [ID]: { repoId: 9, ownerId: 7 } } })).toMatch(
      /differs from registry\/lock/
    );
  });
  it.each([
    ['symlink', { tree: [...BASE_TREE, ent('x.json', { mode: '120000' })] }, /symlink/],
    [
      'submodule',
      { tree: [...BASE_TREE, ent('sub', { mode: '160000', type: 'commit' })] },
      /submodule/
    ],
    ['traversal', { tree: [...BASE_TREE, ent('a/../b.json')] }, /unsafe path/],
    ['confusable name', { tree: [...BASE_TREE, ent('cаlendar.json')] }, /non-ASCII/],
    ['oversized file', { tree: [...BASE_TREE, ent('big.json', { size: 5_000_000 })] }, /over/],
    ['binary', { tree: [...BASE_TREE, ent('x.so')] }, /not allowed/],
    ['truncated tree', { truncated: true }, /failing closed/],
    ['archived repo', { archived: true }, /archived/],
    ['license not allowed', { license: 'NOASSERTION' }, /license/],
    [
      'spec widget with code',
      {
        tree: [...BASE_TREE, ent('Widget.qml')],
        files: { 'Widget.qml': 'import QtQuick\nItem {}' }
      },
      /spec widget but contains code/
    ],
    [
      'missing layout in tree',
      { tree: BASE_TREE.filter((e) => e.path !== 'layout.json') },
      /layout\.json: missing|layout/
    ],
    ['token in a file', { files: { 'README.md': 'key ghp_' + 'a'.repeat(36) } }, /github-token/],
    [
      'hostile layout',
      {
        files: { 'layout.json': layoutJson({ root: { type: 'text', text: '<script>x</script>' } }) }
      },
      /layout\.json/
    ],
    [
      'layout binds an undeclared field',
      {
        files: {
          'layout.json': layoutJson({
            root: { type: 'value', bind: { topic: 'github.prs', field: 'token' } }
          })
        }
      },
      /bindings/
    ],
    [
      'unknown provider',
      {
        files: {
          'widget.json': widgetJson({
            providers: [{ name: 'evil', topics: ['x.y'], fields: ['a'] }],
            capabilities: { network: [], files: [], spawn: [] },
            sampleData: {}
          })
        }
      },
      /not in the catalog/
    ],
    [
      'spec widget with network',
      {
        files: {
          'widget.json': widgetJson({
            capabilities: { network: ['example.com'], files: [], spawn: [] }
          })
        }
      },
      /spec widgets declare no network|combines/
    ]
  ])('rejects %s', async (_n, r, re) => expect(await errs(r as Repo)).toMatch(re));

  const codeWidget = (
    caps: object,
    providers = [{ name: 'system', topics: ['system.cpu'], fields: ['load'], auth: 'none' }]
  ) =>
    widgetJson({
      tier: 'code',
      providers,
      capabilities: { network: [], files: [], spawn: [], ...caps },
      sampleData: undefined
    });
  const codeRepo = (caps: object, qml = 'import QtQuick\nItem {}', providers?: object[]): Repo => ({
    tree: [...BASE_TREE.filter((e) => e.path !== 'layout.json'), ent('Widget.qml')],
    files: { 'widget.json': codeWidget(caps, providers as never), 'Widget.qml': qml }
  });
  it('passes a plain local-system code widget', async () =>
    expect((await go(codeRepo({}))).errors).toEqual([]));
  it('code widget with a sensitive provider fails', async () =>
    expect(
      await errs(
        codeRepo({}, undefined, [
          { name: 'github', topics: ['github.prs'], fields: ['open'], auth: 'vault' }
        ])
      )
    ).toMatch(/public or local-system/));
  it('code widget using Process without declaring spawn fails, declared warns', async () => {
    expect(await errs(codeRepo({}, 'import QtQuick\nProcess { }'))).toMatch(/starts programs/);
    const ok = await go(codeRepo({ spawn: ['date'] }, 'import QtQuick\nProcess { }'));
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.join()).toMatch(/starts programs/);
  });
  it('code widget fetching the network undeclared fails', async () =>
    expect(
      await errs(codeRepo({}, 'import QtQuick\nItem { Component.onCompleted: fetch("https://x") }'))
    ).toMatch(/network requests/));
  it('denylisted path and shell spawn fail', async () => {
    expect(await errs(codeRepo({ files: ['~/.ssh/id_rsa'] }))).toMatch(/protected location/);
    expect(await errs(codeRepo({ spawn: ['bash'] }))).toMatch(/allow-list/);
  });
});

describe('listing-level rules', () => {
  it('rejects a retired id, a reserved prefix, a fixture and a bad namespace', async () => {
    expect(await errs({}, { retired: { ids: [ID] } })).toMatch(/retired/);
    expect(await errs({}, { reserved: { prefixes: ['io.github.someone.'] } })).toMatch(/reserved/);
    expect(
      (
        await go({}, { reserved: { prefixes: ['io.github.someone.'] }, isMaintainer: true })
      ).errors.join()
    ).not.toMatch(/reserved/);
    expect(await errs({}, {}, listing({ source: 'fixture', status: 'planned' }))).toMatch(
      /fixture/
    );
    expect(await errs({}, {}, listing({ id: 'io.github.other.demo' }))).toMatch(/namespace/);
  });
  it('warns about a look-alike name', async () => {
    const r = await go({}, { existing: [{ id: 'io.github.victim.demo', name: 'x' }] });
    expect(r.warnings.join()).toMatch(/looks like/);
  });
  it('distance', () => {
    expect(distance('kitten', 'sitting')).toBe(3);
    expect(distance('demo', 'demo')).toBe(0);
  });
  it('never echoes file contents in the report', async () => {
    const tok = 'ghp_' + 'Q'.repeat(36);
    const r = await go({ files: { 'README.md': tok } });
    expect(report([r])).not.toContain('QQQQ');
    expect(report([r])).toMatch(/FAIL/);
  });
  it('a bad listing never throws', async () => {
    const r = await runGate('x.json', { nope: 1 }, deps());
    expect(r.errors.length).toBe(1);
    expect(OWNER).toBe('someone');
  });
});
