// The submission gate for ONE listing. Aids the maintainer; the human reading of the whole PR diff
// is the control. Runs only trusted code from the base ref and reads the listing as DATA. Every
// network call goes through the same host allow-list as the registry build. Returns problems;
// never throws for a bad listing.
import {
  PENDING,
  assertAllowedUrl,
  assertPlain,
  buildRegistry,
  checkNamespace,
  fetchTree,
  validateListing,
  type FetchFn,
  type Listing,
  type Lock
} from '../build-registry';
import { checkPolicy } from './check-policy';
import { checkProviders, type Catalog } from './check-providers';
import { lintFile } from './lint-code';
import { scanSecrets } from './scan-secrets';
import { scanTree } from './scan-tree';

export interface GateDeps {
  fetch?: FetchFn;
  token?: string;
  lock: Lock;
  catalog: Catalog;
  namespaces?: unknown;
  reserved: { prefixes: string[] };
  retired: { ids: string[] };
  /** Other listings already in the registry: used for the look-alike warning. */
  existing: { id: string; name: string }[];
  isMaintainer: boolean;
}
export interface GateResult {
  id: string;
  errors: string[];
  warnings: string[];
}

const TEXT_CODE = /\.(qml|js|mjs)$/i; // case-insensitive: scanTree also lowercases extensions
const TEXT_ANY = /\.(json|md|txt|qml|js|mjs|svg)$|^(LICENSE|LICENCE|COPYING|NOTICE|qmldir)$/i;
const MAX_TEXT_FILES = 60;
const MAX_TEXT_BYTES = 64 * 1024;

export async function fetchText(
  url: string,
  fetchFn: FetchFn = (u, i) => fetch(u, i)
): Promise<string> {
  const u = assertAllowedUrl(url);
  const res = await fetchFn(u.href, { redirect: 'error', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_TEXT_BYTES) throw new Error('over the size cap');
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

/** Levenshtein distance, small strings only. */
export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[a.length][b.length];
}
const slug = (id: string) => id.split('.').slice(3).join('-').replace(/-/g, '');

export async function runGate(file: string, raw: unknown, deps: GateDeps): Promise<GateResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const id =
    typeof (raw as { id?: unknown })?.id === 'string'
      ? (raw as { id: string }).id.slice(0, 100)
      : file;
  const done = () => ({ id, errors, warnings });

  // G1/G2: listing shape, plain text, namespace, file name, reserved, retired, look-alikes.
  if (!validateListing(raw)) return (errors.push('listing does not match the schema'), done());
  const l = raw as unknown as Listing;
  id = l.id;
  try {
    assertPlain(l, file);
    checkNamespace(l, (deps.namespaces ?? {}) as Record<string, string[]>);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : 'invalid listing');
    return done();
  }
  if (file !== `${l.id}.json`) errors.push('file name must be <id>.json');
  if (deps.retired.ids.includes(l.id)) errors.push('this id is retired and cannot be reused');
  if (!deps.isMaintainer && deps.reserved.prefixes.some((p) => l.id.startsWith(p)))
    errors.push('this id prefix is reserved for maintainers');
  for (const o of deps.existing) {
    if (o.id === l.id) continue;
    const a = slug(l.id);
    const b = slug(o.id);
    if (a && b && (a === b || distance(a, b) <= 1))
      warnings.push(
        `name looks like the existing widget ${o.id.slice(0, 80)}: check it is not a copy`
      );
  }
  if (l.source === 'fixture') return (errors.push('fixture listings are maintainers-only'), done());
  if (errors.length) return done();

  // G3 to G5: the build core (reachability, ids, license at the pinned commit, manifest, widget.json,
  // layout.json, bindings). The lock entry is added by a maintainer at merge, so "pending" is a warning.
  const built = await buildRegistry({
    listings: [{ file, data: raw }],
    fetch: deps.fetch,
    token: deps.token,
    lock: deps.lock,
    namespaces: deps.namespaces,
    readFixture: () => undefined,
    readReview: () => undefined
  });
  for (const e of built.errors) (e.endsWith(PENDING) ? warnings : errors).push(e);
  const w = built.widgets[0];

  const [, owner, repo] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(l.repo) ?? [];
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    const info = await (deps.fetch ?? ((u, i) => fetch(u, i)))(api, {
      redirect: 'error',
      credentials: 'omit',
      headers: deps.token ? { authorization: `Bearer ${deps.token}` } : {}
    }).then((r) => r.json() as Promise<Record<string, unknown>>);
    if (info.archived === true) errors.push('the repository is archived');
  } catch {
    warnings.push('could not read the repository metadata');
  }

  let tree;
  try {
    tree = await fetchTree(owner, repo, l.commit, { fetch: deps.fetch, token: deps.token });
  } catch (e) {
    errors.push(e instanceof Error ? e.message : 'tree could not be read');
    return done();
  }
  errors.push(...scanTree(tree, { entryPoints: ['manifest.json', 'widget.json'] }));
  if (!w) return done();

  // Derived "no custom code" label: a spec widget must contain no QML or JS at all.
  const codeFiles = tree.filter((e) => e.type === 'blob' && TEXT_CODE.test(e.path));
  if (w.declaredTier === 'spec' && codeFiles.length)
    errors.push(`declared as a spec widget but contains code files: ${codeFiles[0].path}`);
  if (w.declaredTier === 'spec' && !tree.some((e) => e.path === 'layout.json'))
    errors.push('layout.json: missing');

  const prov = checkProviders({ providers: w.providers }, deps.catalog);
  errors.push(...prov.problems);
  errors.push(
    ...checkPolicy({
      tier: w.declaredTier,
      capabilities: w.capabilities,
      classes: prov.classes,
      ownDir: `~/.config/omarchy/plugins/${l.id}`
    })
  );

  // G6/G7: text lint (code widgets) and secret scan over the files a reviewer will read.
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${l.commit}`;
  const declared = {
    network: w.capabilities.network.length > 0,
    files: w.capabilities.files.length > 0,
    spawn: w.capabilities.spawn.length > 0
  };
  const texts = tree
    .filter((e) => e.type === 'blob' && TEXT_ANY.test(e.path.split('/').pop() ?? ''))
    .slice(0, MAX_TEXT_FILES);
  if (
    tree.filter((e) => e.type === 'blob' && TEXT_ANY.test(e.path.split('/').pop() ?? '')).length >
    MAX_TEXT_FILES
  )
    warnings.push(
      `only the first ${MAX_TEXT_FILES} text files were scanned: review the rest by hand`
    );
  for (const t of texts) {
    let body: string;
    try {
      body = await fetchText(
        `${base}/${t.path.split('/').map(encodeURIComponent).join('/')}`,
        deps.fetch
      );
    } catch (e) {
      errors.push(
        `${t.path}: could not be read for scanning (${e instanceof Error ? e.message : 'error'})`
      );
      continue;
    }
    errors.push(...scanSecrets(t.path, body));
    if (TEXT_CODE.test(t.path))
      for (const f of lintFile(t.path, body, declared))
        (f.level === 'error' ? errors : warnings).push(`${f.file}:${f.line}: ${f.message}`);
  }
  return done();
}

/** Markdown for the GitHub job summary. Never includes raw file contents. */
export function report(results: GateResult[]): string {
  const lines = [
    '## Registry gate',
    '',
    'These checks help the maintainer. They are not a security review.',
    ''
  ];
  if (!results.length) lines.push('No listing files changed.');
  for (const r of results) {
    lines.push(
      `### ${r.errors.length ? 'FAIL' : 'PASS'}: \`${r.id.replace(/[\r\n`]/g, ' ').slice(0, 100)}\``,
      ''
    );
    for (const e of r.errors.slice(0, 40))
      lines.push(`- error: ${e.replace(/[\r\n`]/g, ' ').slice(0, 300)}`);
    for (const e of r.warnings.slice(0, 20))
      lines.push(`- warning: ${e.replace(/[\r\n`]/g, ' ').slice(0, 300)}`);
    lines.push('');
  }
  return lines.join('\n');
}
