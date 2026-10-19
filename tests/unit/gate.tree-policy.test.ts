import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPolicy, canonPath } from '../../scripts/gate/check-policy';
import { checkProviders, type Catalog } from '../../scripts/gate/check-providers';
import { scanTree } from '../../scripts/gate/scan-tree';

const f = (path: string, over = {}) => ({ path, mode: '100644', type: 'blob', size: 10, ...over });
const ok = [f('manifest.json'), f('widget.json'), f('layout.json'), f('LICENSE'), f('README.md')];

describe('scanTree', () => {
  it('accepts a normal spec widget', () => expect(scanTree(ok)).toEqual([]));
  it.each([
    ['symlink', f('a.qml', { mode: '120000' }), /symlink/],
    ['submodule', f('sub', { mode: '160000', type: 'commit' }), /submodule/],
    ['traversal', f('a/../b.qml'), /unsafe path/],
    ['absolute', f('/etc/x.json'), /unsafe path/],
    ['confusable name', f('cаlendar.qml'), /non-ASCII/],
    ['bidi name', f('x‮gpj.json'), /non-ASCII/],
    ['binary', f('run.so'), /not allowed/],
    ['shell script', f('install.sh'), /not allowed/],
    ['oversized', f('big.json', { size: 2_000_000 }), /over/],
    ['case collision', f('Layout.json'), /only by case/],
    ['uppercase extension', f('Run.QML'), /lowercase/]
  ])('rejects %s', (_n, extra, re) => {
    expect(scanTree([...ok, extra]).join()).toMatch(re);
  });
  it('flags missing entry points and too many files', () => {
    expect(scanTree([f('README.md')]).join()).toMatch(/manifest\.json: missing/);
    const many = Array.from({ length: 301 }, (_, i) => f(`f${i}.json`));
    expect(scanTree([...ok, ...many]).join()).toMatch(/more than/);
  });
  it('allows qmldir and LICENSE without extensions', () => {
    expect(scanTree([...ok, f('qmldir')])).toEqual([]);
  });
});

const caps = (c: Partial<{ network: string[]; files: string[]; spawn: string[] }> = {}) => ({
  network: [],
  files: [],
  spawn: [],
  ...c
});
const own = '~/.config/omarchy/plugins/io.github.a.b';

describe('checkPolicy truth table', () => {
  const base = { tier: 'code' as const, classes: ['local-system'], ownDir: own };
  it('passes a plain local-system code widget', () =>
    expect(checkPolicy({ ...base, capabilities: caps({ spawn: ['date'] }) })).toEqual([]));
  it('spec widgets declare nothing', () =>
    expect(
      checkPolicy({
        ...base,
        tier: 'spec',
        capabilities: caps({ network: ['example.com'] })
      }).join()
    ).toMatch(/spec widgets/));
  it('code widgets cannot use sensitive classes', () =>
    expect(checkPolicy({ ...base, classes: ['personal'], capabilities: caps() }).join()).toMatch(
      /public or local-system/
    ));
  it('no sensitive provider with network (exfil rule)', () =>
    expect(
      checkPolicy({
        ...base,
        tier: 'spec',
        classes: ['personal'],
        capabilities: caps({ network: ['example.com'] })
      }).join()
    ).toMatch(/combines a sensitive provider/));
  it('mail is rejected', () =>
    expect(
      checkPolicy({ ...base, tier: 'spec', classes: ['secret-mail'], capabilities: caps() }).join()
    ).toMatch(/mail/));
  it.each(['127.0.0.1', 'localhost', 'printer.local', '10.0.0.1', 'a_b.com', '*.example.com'])(
    'rejects network host %s',
    (h) =>
      expect(checkPolicy({ ...base, capabilities: caps({ network: [h] }) }).length).toBeGreaterThan(
        0
      )
  );
  it.each([
    '~/.ssh/id_ed25519',
    '~/.aws',
    '~/.config/gh/hosts.yml',
    '$XDG_DATA_HOME/owd/vault.owv',
    '/var/run/docker.sock',
    '~/.config/omarchy/plugins/../../../.ssh/id_rsa',
    '/proc/self/environ',
    '~//.ssh//id',
    '~/*',
    '/run/user/1000/podman/podman.sock'
  ])('rejects files %s', (p) =>
    expect(checkPolicy({ ...base, capabilities: caps({ files: [p] }) }).length).toBeGreaterThan(0)
  );
  it('allows only the own plugin directory', () => {
    expect(checkPolicy({ ...base, capabilities: caps({ files: [`${own}/data`] }) })).toEqual([]);
    expect(checkPolicy({ ...base, capabilities: caps({ files: ['~/Documents'] }) }).join()).toMatch(
      /own plugin directory/
    );
  });
  it.each(['sh', 'bash', 'python3.12', 'env', 'curl', 'docker', 'hyprctl', 'xargs'])(
    'rejects spawn %s',
    (s) =>
      expect(checkPolicy({ ...base, capabilities: caps({ spawn: [s] }) }).join()).toMatch(
        /allow-list/
      )
  );
  it('canonPath collapses and rejects', () => {
    expect(canonPath('~/a//b/../c/')).toBe('~/a/c');
    expect(canonPath('relative/x')).toBeNull();
    expect(canonPath('~/a/*')).toBeNull();
  });
});

describe('checkProviders against registry/providers.json', () => {
  const cat = JSON.parse(readFileSync('registry/providers.json', 'utf8')) as Catalog;
  it('every fixture widget matches the catalog', () => {
    for (const d of readdirSync('registry/fixtures')) {
      const w = JSON.parse(readFileSync(`registry/fixtures/${d}/widget.json`, 'utf8'));
      expect(checkProviders(w, cat).problems, d).toEqual([]);
    }
  });
  it('rejects unknown provider, topic, field and wrong auth', () => {
    const w = (p: object) => ({ providers: [p as never] });
    expect(
      checkProviders(w({ name: 'evil', topics: ['x.y'], fields: [] }), cat).problems.join()
    ).toMatch(/not in the catalog/);
    expect(
      checkProviders(
        w({ name: 'system', topics: ['system.nope'], fields: [] }),
        cat
      ).problems.join()
    ).toMatch(/unknown topic/);
    expect(
      checkProviders(
        w({ name: 'system', topics: ['system.time'], fields: ['secret'] }),
        cat
      ).problems.join()
    ).toMatch(/field secret/);
    expect(
      checkProviders(
        w({ name: 'github', topics: ['github.prs'], fields: ['open'], auth: 'none' }),
        cat
      ).problems.join()
    ).toMatch(/auth is vault/);
  });
  it('prototype-named providers are not found', () => {
    expect(
      checkProviders(
        { providers: [{ name: 'constructor', topics: ['a.b'], fields: [] }] },
        cat
      ).problems.join()
    ).toMatch(/not in the catalog/);
  });
});
