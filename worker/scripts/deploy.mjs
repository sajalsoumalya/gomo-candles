// Deploy the Worker and upload secrets from worker/.secrets in one step.
// Blank values are dropped (so a blank line never wipes a real secret), and the file is never printed.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const file = new URL('../.secrets', import.meta.url);
const args = ['wrangler', 'deploy', ...process.argv.slice(2)];
let tmp = null;

if (existsSync(file)) {
  const secrets = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) val = val.slice(1, -1);
    val = val.replace(/\\\$/g, '$');
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !val) continue;
    secrets[key] = val;
  }
  const names = Object.keys(secrets);
  if (names.length) {
    tmp = mkdtempSync(join(tmpdir(), 'gomo-secrets-'));
    const json = join(tmp, 'secrets.json');
    writeFileSync(json, JSON.stringify(secrets), { mode: 0o600 }); // JSON: no $VAR expansion surprises
    args.push('--secrets-file', json);
    console.log(`Uploading ${names.length} secret(s) with the deploy: ${names.join(', ')}`);
  } else console.log('worker/.secrets has no filled-in values; deploying code only.');
} else {
  console.log('No worker/.secrets file (copy .secrets.example); deploying code only.');
}

const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (tmp) rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
