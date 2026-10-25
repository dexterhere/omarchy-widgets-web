// Registry build. Validates listings, fetches DATA (two JSON files) at a pinned commit, derives
// everything from them and writes registry/dist. It never executes anything from a widget repo.
// Usage: bun scripts/build-registry.ts [--offline] [--skip-reachability] [--out registry/dist]
//        bun scripts/build-registry.ts --local --only <listing id>   (gates on a candidate, writes nothing)
// --skip-reachability is for local development only; CI must never use it.
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  bindsOf,
  checkBindings,
  validateLayout,
  validateSampleData,
  assertPlain,
  LAYOUT_LIMITS,
  SPOOF,
  visible
} from '../src/lib/registry/layout';
import type { Layout, SampleData } from '../src/lib/registry/layout';
import { TREE_LIMITS } from './gate/scan-tree';
import { runGates } from './gate/run';
import type { Catalog } from './gate/check-providers';
import type {
  Access,
  RegistryIndex,
  RegistryWidget,
  ReviewInfo,
  Tier
} from '../src/lib/registry/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REG = join(ROOT, 'registry');
const RAW_HOST = 'raw.githubusercontent.com';
const API_HOST = 'api.github.com';

export const LIMITS = { timeoutMs: 10_000, maxBytes: 256 * 1024, maxListingBytes: 8 * 1024 };

// ---------- schemas ----------
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const schemaDir = join(REG, 'schema');
export const validateListing = ajv.compile(
  readJson(join(schemaDir, 'listing.schema.json')) as object
);
export const validateWidget = ajv.compile(
  readJson(join(schemaDir, 'widget.schema.json')) as object
);
export const validateReview = ajv.compile(
  readJson(join(schemaDir, 'review.schema.json')) as object
);
export const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'version', 'description', 'license'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    version: { type: 'string', pattern: '^[0-9A-Za-z.+-]{1,40}$' },
    description: { type: 'string', maxLength: 2000 },
    license: { type: 'string', pattern: '^[A-Za-z0-9.+() -]{1,60}$' }
  }
};
const validateManifest = ajv.compile(MANIFEST_SCHEMA);
export const pinnedSchemaVersion = (readJson(join(schemaDir, 'PINNED.json')) as { version: string })
  .version;

const errText = (v: { errors?: { instancePath: string; message?: string }[] | null }) =>
  (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');

// ---------- safe fetching ----------
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Only https://raw.githubusercontent.com/... and https://api.github.com/...: no userinfo, port, other host or scheme. */
export function assertAllowedUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('rejected URL: not parseable');
  }
  if (u.protocol !== 'https:') throw new Error(`rejected URL: scheme ${u.protocol} not allowed`);
  if (u.username || u.password) throw new Error('rejected URL: credentials in URL');
  if (u.port) throw new Error('rejected URL: explicit port');
  if (u.hostname !== RAW_HOST && u.hostname !== API_HOST)
    throw new Error(`rejected URL: host ${u.hostname} not allow-listed`);
  if (u.hash) throw new Error('rejected URL: fragment');
  if (u.search) {
    // Per-endpoint allow-list: exactly one named parameter with a strict value, nothing else.
    const rule = QUERY_ALLOW.find((r) => r.path.test(u.pathname));
    const keys = [...u.searchParams.keys()];
    const v = u.searchParams.get(rule?.key ?? '');
    if (!rule || keys.length !== 1 || keys[0] !== rule.key || v === null || !rule.value.test(v))
      throw new Error('rejected URL: query not allowed for this endpoint');
  }
  return u;
}

const QUERY_ALLOW = [
  { path: /^\/repos\/[^/]+\/[^/]+\/git\/trees\/[0-9a-f]{40}$/, key: 'recursive', value: /^1$/ },
  { path: /^\/repos\/[^/]+\/[^/]+\/license$/, key: 'ref', value: /^[0-9a-f]{40}$/ }
];

interface FetchOpts {
  fetch?: FetchFn;
  timeoutMs?: number;
  maxBytes?: number;
  token?: string;
}

/** The one place that talks to GitHub: allow-listed URL, no redirects, no cookies, timeout and a
 *  streaming size cap. fetchJson and fetchText only differ in how they read the bytes. `text`
 *  files may carry any content type (we only read them as data, never render them). */
async function fetchBody(
  rawUrl: string,
  opts: FetchOpts & { text?: boolean } = {}
): Promise<Uint8Array> {
  const url = assertAllowedUrl(rawUrl);
  const { timeoutMs = LIMITS.timeoutMs, maxBytes = LIMITS.maxBytes } = opts;
  const doFetch: FetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error(`timeout after ${timeoutMs} ms: ${url.pathname}`));
    }, timeoutMs);
  });
  const work = (async () => {
    // The token (if any) goes ONLY to api.github.com, never to the raw host. No cookies are sent;
    // redirects are errors, not followed.
    const res = await doFetch(url.href, {
      redirect: 'error',
      signal: ctl.signal,
      credentials: 'omit',
      headers: {
        accept: opts.text ? 'text/plain, */*' : 'application/json',
        ...(opts.token && url.hostname === API_HOST
          ? { authorization: `Bearer ${opts.token}` }
          : {})
      }
    });
    if (res.redirected || (res.status >= 300 && res.status < 400))
      throw new Error('rejected: redirect');
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url.pathname}`);
    const type = res.headers.get('content-type') ?? '';
    if (!opts.text && /html|xml|javascript/i.test(type))
      throw new Error(`rejected: content-type ${type.split(';')[0]}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error(`rejected: body over ${maxBytes} bytes`);
    if (!res.body) throw new Error('rejected: empty body'); // fail closed, also for text files
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`rejected: body over ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    return buf;
  })();
  work.catch(() => {}); // avoid an unhandled rejection if the timeout wins the race
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Parsed JSON plus the sha256 (lowercase hex) of the exact bytes it was parsed from. The hash is
 *  what `ow install` compares the fetched files against, so it must cover the raw bytes. */
export async function fetchJsonHashed(
  rawUrl: string,
  opts: FetchOpts = {}
): Promise<{ json: Record<string, unknown>; sha256: string }> {
  const buf = await fetchBody(rawUrl, opts);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
  } catch {
    throw new Error(`rejected: not valid JSON: ${new URL(rawUrl).pathname}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('rejected: JSON root must be an object');
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { json: parsed as Record<string, unknown>, sha256 };
}

export async function fetchJson(
  rawUrl: string,
  opts: FetchOpts = {}
): Promise<Record<string, unknown>> {
  return (await fetchJsonHashed(rawUrl, opts)).json;
}

/** A text file from the pinned commit (UTF-8 only), under exactly the rules of fetchJson. */
export async function fetchText(rawUrl: string, opts: FetchOpts = {}): Promise<string> {
  const buf = await fetchBody(rawUrl, { ...opts, text: true });
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new Error('rejected: not valid UTF-8');
  }
}

// ---------- commit reachability ----------
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._+@#~-]+(?:\/[A-Za-z0-9._+@#~-]+)*$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.hasOwn(o, k) ? o[k] : undefined;

/** raw.githubusercontent.com serves a commit from ANY repo in a fork network, so a listing could
 *  name the victim's repo but pin a fork's commit. Require the commit to be an ancestor of (or
 *  equal to) the repo's default branch: compare status "behind" or "identical". */
export async function assertCommitReachable(
  owner: string,
  repo: string,
  commit: string,
  opts: { fetch?: FetchFn; token?: string } = {}
): Promise<{ repoId: unknown; ownerId: unknown; committed: string | null }> {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || !COMMIT_RE.test(commit))
    throw new Error('reachability: invalid owner, repo or commit');
  const api = `https://${API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const info = await fetchJson(api, opts);
  const branch = own(info, 'default_branch');
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch) || branch.includes('..'))
    throw new Error('reachability: unusable default branch name');
  const seg = branch.split('/').map(encodeURIComponent).join('/');
  const cmp = await fetchJson(`${api}/compare/${seg}...${commit}`, opts).catch((e) => {
    if (e instanceof Error && /HTTP 404/.test(e.message))
      throw new Error('commit not found in this repository (is it from a fork?)');
    throw e;
  });
  const status = own(cmp, 'status');
  if (status !== 'behind' && status !== 'identical')
    throw new Error(
      `commit is not reachable from the default branch ${branch} (compare status: ${typeof status === 'string' ? status.slice(0, 20) : 'unknown'})`
    );
  const ownerObj = own(info, 'owner');
  // For "behind" and "identical" the merge base is the pinned commit itself, so its committer
  // date comes from the compare response we already fetched (no extra request).
  const base = own(cmp, 'merge_base_commit') as { commit?: { committer?: { date?: unknown } } };
  const when = base?.commit?.committer?.date;
  const committed =
    typeof when === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(when) ? when.slice(0, 10) : null;
  return {
    committed,
    repoId: own(info, 'id'),
    ownerId:
      ownerObj && typeof ownerObj === 'object'
        ? own(ownerObj as Record<string, unknown>, 'id')
        : undefined
  };
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  size?: number;
}

/** The full file tree at a commit. Fails closed when GitHub says the list was cut short: an
 *  incomplete tree must never pass a scan. */
export async function fetchTree(
  owner: string,
  repo: string,
  commit: string,
  opts: { fetch?: FetchFn; token?: string } = {}
): Promise<TreeEntry[]> {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || !COMMIT_RE.test(commit))
    throw new Error('tree: invalid owner, repo or commit');
  const t = await fetchJson(
    `https://${API_HOST}/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`,
    { ...opts, maxBytes: 4 * 1024 * 1024 }
  );
  if (own(t, 'truncated') !== false)
    throw new Error('tree is truncated or unreadable: failing closed');
  const tree = own(t, 'tree');
  if (!Array.isArray(tree)) throw new Error('tree: unexpected response');
  return tree.map((e) => {
    const o = e as Record<string, unknown>;
    return {
      path: String(own(o, 'path')),
      mode: String(own(o, 'mode')),
      type: String(own(o, 'type')),
      size: typeof own(o, 'size') === 'number' ? (own(o, 'size') as number) : undefined
    };
  });
}

/** Licenses a listing may carry. The SPDX id comes from GitHub's detection of the LICENSE blob at
 *  the pinned commit, never from the author's manifest. */
export const LICENSE_ALLOW = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'GPL-3.0',
  'LGPL-3.0',
  'AGPL-3.0',
  'Unlicense',
  '0BSD'
]);

export async function checkLicense(
  owner: string,
  repo: string,
  commit: string,
  declared: unknown,
  opts: { fetch?: FetchFn; token?: string } = {}
): Promise<void> {
  const r = await fetchJson(
    `https://${API_HOST}/repos/${owner}/${repo}/license?ref=${commit}`,
    opts
  ).catch((e) => {
    if (e instanceof Error && /HTTP 404/.test(e.message))
      throw new Error('no LICENSE file found at the pinned commit');
    throw e;
  });
  const lic = own(r, 'license');
  const spdx =
    lic && typeof lic === 'object' ? own(lic as Record<string, unknown>, 'spdx_id') : undefined;
  if (typeof spdx !== 'string' || !LICENSE_ALLOW.has(spdx))
    throw new Error(
      `license not recognised or not allowed (detected: ${typeof spdx === 'string' ? spdx.slice(0, 30) : 'none'})`
    );
  if (declared !== spdx)
    throw new Error(
      `manifest license ${String(declared).slice(0, 30)} differs from the detected ${spdx}`
    );
}

/** registry/lock.json: numeric GitHub ids a maintainer recorded when approving a listing. A
 *  renamed or transferred repo keeps its id; a deleted and re-created one does not. */
export type Lock = Record<string, { repoId: number; ownerId: number }>;
export const PENDING = 'pending maintainer approval: no entry in registry/lock.json';

export function checkLock(
  id: string,
  lock: Lock,
  seen: { repoId: unknown; ownerId: unknown }
): void {
  const e = Object.hasOwn(lock, id) ? lock[id] : undefined;
  if (!e) throw new Error(PENDING);
  if (e.repoId !== seen.repoId || e.ownerId !== seen.ownerId)
    throw new Error(
      'repo or owner id differs from registry/lock.json (deleted, re-created or transferred?)'
    );
}

// ---------- plain text ----------
// SECURITY: no field in the output may ever be rendered with {@html} or innerHTML. Everything
// here is data from strangers; it is only ever shown as text.
export { assertPlain };

/** Plain text only: rejects spoofing characters and HTML-looking text, collapses spaces, caps length. */
export function cleanText(input: unknown, max: number, field: string): string {
  if (typeof input !== 'string') throw new Error(`${field}: must be a string`);
  assertPlain(input, field);
  const s = input.replace(/\s+/g, ' ').trim();
  if (!s || !visible(s)) throw new Error(`${field}: empty`);
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

// ---------- access summary ----------
type WidgetJson = {
  providers: { name: string; topics: string[]; fields: string[]; auth?: string }[];
  capabilities: { network: string[]; files: string[]; spawn: string[] };
};

/** Plain-language access summary. Always says "none" explicitly rather than omitting a row. */
export function describeAccess(w: WidgetJson): Access {
  const orNone = (a: string[]) => (a.length ? a : ['none']);
  return {
    data: orNone(
      w.providers.map(
        (p) =>
          `${p.topics.join(', ')}: ${p.fields.length ? p.fields.join(', ') : 'no fields listed'}`
      )
    ),
    network: orNone(w.capabilities.network),
    files: orNone(w.capabilities.files),
    programs: orNone(w.capabilities.spawn),
    secrets: orNone(
      w.providers
        .filter((p) => p.auth === 'vault')
        .map((p) => `a ${p.name} credential kept in your vault (the widget never sees it)`)
    )
  };
}

// ---------- namespace ownership ----------
export const validateNamespaces = ajv.compile(
  readJson(join(schemaDir, 'namespaces.schema.json')) as object
);
export type Namespaces = Record<string, string[]>;

function parseNamespaces(raw: unknown, errors: string[]): Namespaces {
  if (raw === undefined) return {};
  if (!validateNamespaces(raw)) {
    errors.push(`namespaces.json: ${errText(validateNamespaces)}`);
    return {};
  }
  return raw as Namespaces;
}

/** io.github.<owner>.<name> must be listed from a repo owned by <owner>. Any other namespace
 *  needs a maintainer entry in registry/namespaces.json naming the allowed repo owner. */
export function checkNamespace(l: Pick<Listing, 'id' | 'repo'>, ns: Namespaces): void {
  const repoOwner = l.repo.split('/')[3].toLowerCase();
  if (l.id.startsWith('io.github.')) {
    if (l.id.split('.')[2] !== repoOwner)
      throw new Error('id namespace io.github.<owner> must match the repo owner');
    return;
  }
  const hit = Object.entries(ns).find(([prefix]) => l.id.startsWith(`${prefix}.`));
  if (!hit || !hit[1].some((o) => o.toLowerCase() === repoOwner))
    throw new Error(
      'id namespace is not allowed for this repo owner (see registry/namespaces.json)'
    );
}

// ---------- output ----------
const SAFE_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** Writes dist. Every id is re-checked first, so nothing can escape out/widgets or collide. */
export function writeDist(out: string, index: RegistryIndex, widgets: RegistryWidget[]): void {
  for (const w of widgets) {
    if (!SAFE_ID.test(w.id) || w.id.length > 100) throw new Error('refusing to write: unsafe id');
  }
  rmSync(join(out, 'widgets'), { recursive: true, force: true });
  mkdirSync(join(out, 'widgets'), { recursive: true });
  const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
  writeFileSync(join(out, 'index.json'), json(index));
  for (const w of widgets) writeFileSync(join(out, 'widgets', `${w.id}.json`), json(w));
}

// ---------- build ----------
export interface Listing {
  id: string;
  repo: string;
  commit: string;
  categories: RegistryWidget['categories'];
  tags: string[];
  summary: string;
  status: 'planned' | 'alpha' | 'stable' | 'removed';
  source?: 'fixture';
}

export interface BuildInput {
  /** Parsed listing files; `file` is only used in messages. */
  listings: { file: string; data: unknown }[];
  fetch?: FetchFn;
  offline?: boolean;
  /** Local development only. CI must not set this (a test checks ci.yml). */
  skipReachability?: boolean;
  /** GitHub token, sent only to api.github.com. */
  token?: string;
  readFixture: (id: string, name: 'manifest' | 'widget' | 'layout') => unknown;
  readReview: (id: string) => unknown;
  /** registry/namespaces.json: namespace prefix -> allowed GitHub repo owners. */
  namespaces?: unknown;
  /** registry/providers.json; defaults to the checked-in catalog. */
  catalog?: Catalog;
  /** registry/lock.json. When set, every non-fixture listing needs a matching entry. */
  lock?: Lock;
}

export interface BuildResult {
  index: RegistryIndex;
  widgets: RegistryWidget[];
  errors: string[];
}

const DEFAULT_CATALOG = readJson(join(REG, 'providers.json')) as Catalog;
const FIXTURE_UPDATED = '2026-01-15';

async function buildOne(l: Listing, inp: BuildInput): Promise<RegistryWidget> {
  let manifest: Record<string, unknown>;
  let widget: Record<string, unknown>;
  let layoutRaw: unknown;
  let src: { owner: string; repo: string } | null = null;
  let hashes: Record<string, string> | undefined; // real listings only; fixtures have no files
  const fixture = l.source === 'fixture';
  // Committer date (yyyy-mm-dd, UTC) of the pinned commit. Fixtures get a fixed date; null when
  // the reachability check was skipped or GitHub did not return one.
  let updated: string | null = fixture ? FIXTURE_UPDATED : null;
  if (fixture) {
    manifest = inp.readFixture(l.id, 'manifest') as Record<string, unknown>;
    widget = inp.readFixture(l.id, 'widget') as Record<string, unknown>;
    if (!manifest || !widget) throw new Error('fixture files missing');
    layoutRaw = inp.readFixture(l.id, 'layout');
  } else {
    if (inp.offline) throw new Error('needs the network, but --offline was given');
    const [, owner, repo] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(l.repo) ?? [];
    if (!inp.skipReachability) {
      const seen = await assertCommitReachable(owner, repo, l.commit, {
        fetch: inp.fetch,
        token: inp.token
      });
      updated = seen.committed;
      if (inp.lock) {
        checkLock(l.id, inp.lock, seen);
        const m = await fetchJson(
          `https://${RAW_HOST}/${owner}/${repo}/${l.commit}/manifest.json`,
          {
            fetch: inp.fetch
          }
        );
        await checkLicense(owner, repo, l.commit, m.license, {
          fetch: inp.fetch,
          token: inp.token
        });
      }
    }
    src = { owner, repo };
    const base = `https://${RAW_HOST}/${owner}/${repo}/${l.commit}`;
    const m = await fetchJsonHashed(`${base}/manifest.json`, { fetch: inp.fetch });
    const wj = await fetchJsonHashed(`${base}/widget.json`, { fetch: inp.fetch });
    manifest = m.json;
    widget = wj.json;
    hashes = { 'manifest.json': m.sha256, 'widget.json': wj.sha256 };
    // Spec widgets are validated against their layout. A code widget's layout.json is only hashed
    // (never trusted): `ow install` fetches all three files, so it checks all three. If it cannot
    // be read we publish no hashes at all, because `ow` rejects a partial hash set.
    const lay = await fetchJsonHashed(`${base}/layout.json`, {
      fetch: inp.fetch,
      maxBytes: LAYOUT_LIMITS.bytes
    }).catch((e) => {
      if (widget.tier === 'spec') throw e;
      return null;
    });
    if (lay) {
      hashes['layout.json'] = lay.sha256;
      if (widget.tier === 'spec') layoutRaw = lay.json;
    } else hashes = undefined;
  }
  if (!validateManifest(manifest))
    throw new Error(`manifest.json invalid: ${errText(validateManifest)}`);
  if (!validateWidget(widget)) throw new Error(`widget.json invalid: ${errText(validateWidget)}`);
  assertPlain(manifest, 'manifest.json');
  assertPlain(widget, 'widget.json');
  const w = widget as unknown as WidgetJson &
    Pick<
      RegistryWidget,
      'id' | 'category' | 'surfaces' | 'sizeClasses' | 'variants' | 'settings' | 'compat'
    > & {
      tier: string;
    };
  if (manifest.id !== l.id || w.id !== l.id)
    throw new Error('id mismatch across listing, manifest.json and widget.json');
  // widget.json names the primary category; the listing may add up to two more. The primary
  // comes first, the rest are sorted, so the output never depends on listing order.
  const cats = [...new Set(l.categories)];
  if (!cats.length || cats.length > 3) throw new Error('categories must hold 1 to 3 slugs');
  if (!cats.includes(w.category))
    throw new Error('widget.json category is not one of the listing categories');
  const categories = [w.category, ...cats.filter((c) => c !== w.category).sort()];

  // Spec widgets: validate the view tree and its sample data, and cross-check every binding.
  let layout: Layout | null = null;
  let sampleData: SampleData | null = null;
  if (w.tier === 'spec') {
    if (layoutRaw === undefined || layoutRaw === null)
      throw new Error('spec widget needs layout.json');
    assertPlain(layoutRaw, 'layout.json');
    const sd = (widget as { sampleData?: unknown }).sampleData ?? {};
    const sdErr = validateSampleData(sd);
    if (sdErr.length) throw new Error(`sampleData invalid: ${sdErr.slice(0, 3).join('; ')}`);
    const r = validateLayout(layoutRaw, w.variants);
    if (!r.ok) throw new Error(`layout.json invalid: ${r.errors.slice(0, 3).join('; ')}`);
    const all = [
      ...bindsOf(r.layout.root),
      ...Object.values(r.layout.variants ?? {}).flatMap(bindsOf)
    ];
    const bErr = checkBindings(all, w.providers, sd as SampleData);
    if (bErr.length) throw new Error(`layout.json bindings: ${bErr.slice(0, 3).join('; ')}`);
    layout = r.layout;
    sampleData = sd as SampleData;
  }

  // The tier is NEVER taken from widget.json (author controlled) or the listing. Only a
  // maintainer review record for this exact commit can grant core, verified or spec.
  let tier: Tier = fixture ? 'concept' : 'community';
  let review: ReviewInfo | null = null;
  let reviewNote: string | null = null;
  const rec = fixture ? undefined : inp.readReview(l.id);
  if (rec !== undefined) {
    if (!validateReview(rec))
      reviewNote = `review record ignored: invalid (${errText(validateReview)})`;
    else {
      assertPlain(rec, 'review record');
      const r = rec as unknown as ReviewInfo & { id: string };
      if (r.id !== l.id) reviewNote = 'review record ignored: id does not match';
      else if (r.reviewedCommit !== l.commit)
        reviewNote = `review record ignored: it covers ${r.reviewedCommit.slice(0, 12)}, this listing pins ${l.commit.slice(0, 12)}`;
      else {
        tier = r.tier;
        review = {
          tier: r.tier,
          reviewer: cleanText(r.reviewer, 80, 'reviewer'),
          date: r.date,
          reviewedCommit: r.reviewedCommit
        };
      }
    }
  }

  // Gates (G4-G7) on the pinned tree. Fixtures skip them (they have no repo). Any error-level
  // finding excludes the listing; the reason is secret-free (count plus the first three findings).
  let warnings: string[] = [];
  if (src) {
    const { owner, repo } = src;
    const entries = await fetchTree(owner, repo, l.commit, { fetch: inp.fetch, token: inp.token });
    const g = await runGates({
      id: l.id,
      widget: w,
      entries,
      catalog: inp.catalog ?? DEFAULT_CATALOG,
      readText: (path) =>
        fetchText(
          `https://${RAW_HOST}/${owner}/${repo}/${l.commit}/${path.split('/').map(encodeURIComponent).join('/')}`,
          { fetch: inp.fetch, maxBytes: TREE_LIMITS.maxFileBytes }
        )
    });
    if (g.errors.length)
      throw new Error(`gates: ${g.errors.length} problem(s): ${g.errors.slice(0, 3).join(' | ')}`);
    warnings = g.warnings.slice(0, 10).map((x) => scrub(x).slice(0, 200));
  }

  return {
    id: l.id,
    name: cleanText(manifest.name, 80, 'name'),
    version: manifest.version as string,
    description: cleanText(manifest.description, 500, 'description'),
    summary: cleanText(l.summary, 140, 'summary'),
    license: manifest.license as string,
    repo: l.repo,
    commit: l.commit,
    ...(hashes ? { sha256: hashes } : {}),
    updated,
    category: categories[0],
    categories,
    tags: l.tags,
    status: l.status as RegistryWidget['status'],
    tier,
    declaredTier: w.tier === 'spec' ? 'spec' : 'code',
    installable: l.status === 'alpha' || l.status === 'stable',
    review,
    reviewNote,
    surfaces: w.surfaces,
    sizeClasses: w.sizeClasses,
    variants: w.variants,
    providers: w.providers as RegistryWidget['providers'],
    capabilities: w.capabilities,
    settings: w.settings.map((s) => ({
      ...s,
      ...(s.label === undefined ? {} : { label: cleanText(s.label, 80, `setting ${s.key} label`) }),
      ...(s.options
        ? { options: s.options.map((o) => cleanText(o, 40, `setting ${s.key} option`)) }
        : {})
    })),
    compat: w.compat,
    access: describeAccess(w),
    layout,
    sampleData,
    ...(warnings.length ? { warnings } : {})
  };
}

/** Author-controlled text in published fields: spoofing characters and markup-looking text become '?'. */
export const scrub = (e: string) =>
  e.replace(new RegExp(SPOOF.source, 'gu'), '?').replace(/[<>]/g, '?');

const tally = (xs: string[]) =>
  Object.fromEntries(
    [...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length] as [string, number])
  );

export async function buildRegistry(inp: BuildInput): Promise<BuildResult> {
  const errors: string[] = [];
  const nsMap = parseNamespaces(inp.namespaces, errors);
  const valid: Listing[] = [];
  const seen = new Set<string>();
  for (const { file, data } of inp.listings) {
    if (!validateListing(data)) {
      errors.push(`${file}: ${errText(validateListing)}`);
      continue;
    }
    const l = data as unknown as Listing;
    try {
      assertPlain(l, file);
      checkNamespace(l, nsMap);
    } catch (e) {
      errors.push(`${file}: ${e instanceof Error ? e.message : 'invalid'}`);
      continue;
    }
    if (file !== `${l.id}.json`) {
      errors.push(`${file}: file name must be <id>.json`);
      continue; // a mismatched listing is never published
    }
    if (seen.has(l.id)) {
      errors.push(`${file}: duplicate id ${l.id}`);
      continue;
    }
    seen.add(l.id);
    if (l.status !== 'removed') valid.push(l); // removed: no fetch, no output
  }
  const widgets: RegistryWidget[] = [];
  for (const l of valid) {
    try {
      widgets.push(await buildOne(l, inp));
    } catch (e) {
      errors.push(`${l.id}: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  }
  widgets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index: RegistryIndex = {
    schemaVersion: 1,
    widgetSchema: pinnedSchemaVersion,
    counts: {
      total: widgets.length,
      byStatus: tally(widgets.map((w) => w.status)),
      byTier: tally(widgets.map((w) => w.tier)),
      byCategory: tally(widgets.flatMap((w) => w.categories))
    },
    widgets,
    excluded: errors.map((e) => {
      // Error text can echo author-controlled names (file names, paths): neutralise it before
      // publishing. Spoofing characters and markup-looking text become '?'.
      e = scrub(e);
      const i = e.indexOf(': ');
      return {
        ref: (i > 0 ? e.slice(0, i) : 'registry').slice(0, 120),
        reason: (i > 0 ? e.slice(i + 2) : e).slice(0, 300),
        pending: e.endsWith(PENDING)
      };
    })
  };
  return { index, widgets, errors };
}

// ---------- CLI ----------
/** `--local --only <id>`: run the reachability, fetch and gate steps for one candidate listing that
 *  has no registry/lock.json entry yet, and write nothing. It could skip the maintainer approval, so
 *  it refuses to run in CI (GITHUB_ACTIONS=true) or together with --strict. Returns the id, or null. */
export function localMode(args: string[], env: Record<string, string | undefined>): string | null {
  if (!args.includes('--local')) return null;
  const ga = (env.GITHUB_ACTIONS ?? '').trim().toLowerCase();
  if ((ga !== '' && ga !== 'false' && ga !== '0') || (env.CI ?? '') !== '')
    throw new Error('--local is refused in CI');
  if (args.includes('--strict')) throw new Error('--local cannot be combined with --strict');
  const i = args.indexOf('--only');
  if (i < 0 || !args[i + 1]) throw new Error('--local needs --only <listing id>');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(args[i + 1]))
    throw new Error('--only needs a listing id');
  return args[i + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const skipReachability = args.includes('--skip-reachability');
  const strict = args.includes('--strict'); // CI on pull requests: any problem fails the run
  const only = localMode(args, process.env);
  const oi = args.indexOf('--out');
  const out = resolve(ROOT, oi >= 0 && args[oi + 1] ? args[oi + 1] : 'registry/dist');
  const dir = join(REG, 'widgets');
  const listings = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && (only === null || f === `${only}.json`))
    .sort()
    .map((file) => {
      // Only regular files: a symlink or directory named *.json is excluded, never followed.
      try {
        if (!lstatSync(join(dir, file)).isFile()) return { file, data: null };
        const raw = readFileSync(join(dir, file), 'utf8');
        if (raw.length > LIMITS.maxListingBytes) return { file, data: null };
        return { file, data: JSON.parse(raw) as unknown };
      } catch {
        return { file, data: null };
      }
    });
  const optional = (p: string) => (existsSync(p) ? readJson(p) : undefined);
  const { index, widgets, errors } = await buildRegistry({
    listings,
    offline,
    skipReachability,
    token: process.env.GITHUB_TOKEN || undefined,
    readFixture: (id, name) => optional(join(REG, 'fixtures', id, `${name}.json`)),
    namespaces: optional(join(REG, 'namespaces.json')),
    // --local: no lock, so no pending-approval skip. Everything else (gates included) still runs.
    lock:
      only === null ? ((optional(join(REG, 'lock.json')) as Lock | undefined) ?? {}) : undefined,
    readReview: (id) =>
      /^[a-z0-9.-]+$/.test(id) ? optional(join(REG, 'review', `${id}.json`)) : undefined
  });

  for (const w of widgets)
    console.log(
      `${w.id.padEnd(48)} ${w.status.padEnd(8)} ${w.tier.padEnd(10)} ${w.reviewNote ?? ''}`
    );
  // One bad listing never blocks the rest: it is excluded, listed in index.json and reported.
  // Pending approvals are not failures. --strict (pull requests) fails on every other problem.
  if (errors.length) {
    console.error(`\nregistry: ${errors.length} listing(s) excluded`);
    for (const e of errors) console.error(`  - ${e}`);
  }
  if (only !== null) {
    for (const w of widgets) for (const x of w.warnings ?? []) console.log(`  warning: ${x}`);
    console.log(`\nregistry --local: ${widgets.length ? 'passed' : 'excluded'} (nothing written)`);
    process.exit(widgets.length ? 0 : 1);
  }
  if (strict && index.excluded.some((x) => !x.pending)) process.exit(1);
  writeDist(out, index, widgets);
  console.log(`\nregistry: ${widgets.length} widget(s) written to ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`registry: ${e instanceof Error ? e.message : 'failed'}`);
    process.exit(1);
  });
}
