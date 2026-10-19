// CI entry for the registry gate. Run from the BASE ref checkout (trusted scripts). The PR head is
// fetched into FETCH_HEAD and only registry/widgets/*.json is read from it, with `git show`: head
// code is never executed. Usage: HEAD_SHA=<sha> BASE_SHA=<sha> PR_AUTHOR=<login> bun scripts/gate.ts
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LISTING } from './check-review-changes';
import { report, runGate, type GateResult } from './gate/run-gate';

const REG = 'registry';
const readJson = (p: string, d: unknown) =>
  existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d;
const SHA = /^[0-9a-f]{40}$/;

async function main() {
  const { HEAD_SHA = '', BASE_SHA = '', PR_AUTHOR = '' } = process.env;
  if (!SHA.test(HEAD_SHA) || !SHA.test(BASE_SHA))
    throw new Error('HEAD_SHA and BASE_SHA must be full SHAs');
  const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 20 });
  const changed = git(
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    `${BASE_SHA}...${HEAD_SHA}`,
    '--',
    'registry/widgets/'
  )
    .split('\0')
    .filter(Boolean);
  const maintainers = readJson(join(REG, 'MAINTAINERS.json'), []) as string[];
  const existing = readdirSync(join(REG, 'widgets'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ id: f.slice(0, -5), name: f.slice(0, -5) }));
  const deps = {
    token: process.env.GITHUB_TOKEN || undefined,
    lock: readJson(join(REG, 'lock.json'), {}) as never,
    catalog: readJson(join(REG, 'providers.json'), { schemaVersion: 0, providers: {} }) as never,
    namespaces: readJson(join(REG, 'namespaces.json'), {}),
    reserved: readJson(join(REG, 'reserved.json'), { prefixes: [] }) as never,
    retired: readJson(join(REG, 'retired.json'), { ids: [] }) as never,
    existing,
    isMaintainer: maintainers.map((m) => m.toLowerCase()).includes(PR_AUTHOR.toLowerCase())
  };
  const results: GateResult[] = [];
  for (let k = 0; k + 1 < changed.length; k += 2) {
    const [status, path] = [changed[k], changed[k + 1]];
    const m = LISTING.exec(path);
    if (!m || status === 'D') continue;
    let data: unknown = null;
    try {
      const raw = git('show', `${HEAD_SHA}:${path}`);
      data = raw.length > 8 * 1024 ? null : JSON.parse(raw);
    } catch {
      data = null;
    }
    results.push(await runGate(`${m[1]}.json`, data, deps));
  }
  const md = report(results);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  if (results.some((r) => r.errors.length)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(`gate: ${e instanceof Error ? e.message : 'failed'}`);
    process.exit(1);
  });
