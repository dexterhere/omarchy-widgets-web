// Gate G4: checks the file list of a widget repo at the pinned commit. Pure: takes the entries
// from fetchTree (GitHub's tree API), returns problems. Nothing here reads file contents.
import type { TreeEntry } from '../build-registry';

export const TREE_LIMITS = {
  maxFiles: 300,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024
};

/** Extensions a widget repo may contain. Anything else (binaries, archives, scripts) is rejected. */
export const EXT_ALLOW = new Set([
  'json',
  'md',
  'txt',
  'qml',
  'js',
  'mjs',
  'png',
  'svg',
  'webp',
  'jpg',
  'jpeg',
  'ttf',
  'otf',
  'woff2'
]);
/** Extension-less names that are allowed (qmldir lists QML modules). */
export const NAME_ALLOW = new Set([
  'LICENSE',
  'LICENCE',
  'COPYING',
  'NOTICE',
  'qmldir',
  '.gitignore'
]);

const CONFUSABLE = /[^ -~]/; // any non-ASCII name is rejected: no lookalike letters, no bidi
const SYMLINK = '120000';
const SUBMODULE = '160000';

export function scanTree(entries: TreeEntry[], opts: { entryPoints?: string[] } = {}): string[] {
  const out: string[] = [];
  const add = (m: string) => out.length < 50 && out.push(m);
  const files = entries.filter((e) => e.type === 'blob');
  if (files.length > TREE_LIMITS.maxFiles) add(`more than ${TREE_LIMITS.maxFiles} files`);
  let total = 0;
  const lower = new Map<string, string>();
  for (const e of entries) {
    const p = e.path;
    if (e.mode === SYMLINK) add(`${p}: symlink`);
    if (e.mode === SUBMODULE || e.type === 'commit') add(`${p}: submodule`);
    if (CONFUSABLE.test(p))
      add(`${p.replace(/[^ -~]/g, '?')}: non-ASCII or control characters in the name`);
    if (p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '.' || s === ''))
      add(`${p}: unsafe path`);
    const key = p.toLowerCase();
    const seen = lower.get(key);
    if (seen !== undefined && seen !== p) add(`${p}: differs from ${seen} only by case`);
    lower.set(key, p);
    if (e.type !== 'blob') continue;
    const base = p.split('/').pop() ?? '';
    const rawExt = base.includes('.') ? base.split('.').pop()! : '';
    if (rawExt !== rawExt.toLowerCase()) add(`${p}: file extensions must be lowercase`);
    const ext = rawExt.toLowerCase();
    if (!(ext ? EXT_ALLOW.has(ext) : NAME_ALLOW.has(base)) && !NAME_ALLOW.has(base))
      add(`${p}: file type not allowed`);
    const size = e.size ?? 0;
    if (size > TREE_LIMITS.maxFileBytes) add(`${p}: over ${TREE_LIMITS.maxFileBytes} bytes`);
    total += size;
  }
  if (total > TREE_LIMITS.maxTotalBytes)
    add(`repository over ${TREE_LIMITS.maxTotalBytes} bytes in total`);
  const paths = new Set(files.map((f) => f.path));
  for (const need of opts.entryPoints ?? ['manifest.json', 'widget.json'])
    if (!paths.has(need)) add(`${need}: missing`);
  return out;
}
