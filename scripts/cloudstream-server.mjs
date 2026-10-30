#!/usr/bin/env node
/**
 * Auto-start the CloudStream plugin server next to PRAHA.
 *
 * Native .cs3 providers are Android/Kotlin code; this launcher fetches and
 * runs the community CloudStream Web server (built on the official
 * recloudstream/cloudstream library), which executes those plugins on the
 * JVM and serves their home pages, search, episodes, and links on
 * http://localhost:8080. PRAHA auto-detects it when the CloudStream tab
 * opens — no URL to paste.
 *
 * Usage:
 *   npm run server:cloudstream     # server only
 *   npm run dev:full               # server + PRAHA dev server together
 *
 * Requires JDK 21+ and git. First run clones and builds, which takes a
 * while; later runs reuse the checkout in .cloudstream-server/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const installDir = path.join(root, '.cloudstream-server');
const repoDir = path.join(installDir, 'cloudstream-web-unofficial');
const repoUrl = 'https://github.com/SusyBegula/cloudstream-web-unofficial.git';
const port = process.env.SERVER_PORT || '8080';
const withDev = process.argv.includes('--dev');
const children = [];

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    children.push(child);
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });

const shutdown = () => {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
};
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

function javaMajor() {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8' });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  const match = text.match(/version "(?:1\.)?(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function main() {
  const major = javaMajor();
  if (major < 21) {
    console.warn('\n⚠️  CloudStream plugin server needs JDK 21+ (not found).');
    console.warn('    Install it (e.g. https://adoptium.net) and re-run. PRAHA will still start;');
    console.warn('    native .cs3 providers will connect automatically once the server runs.\n');
  } else if (!existsSync(path.join(repoDir, 'gradlew'))) {
    console.log('📥 Downloading the CloudStream plugin server (first run only)…');
    const cloned = await run('git', ['clone', '--recursive', '--depth', '1', repoUrl, repoDir]);
    if (cloned !== 0) {
      console.warn('⚠️  Could not download the plugin server. Check your connection and re-run.');
    }
  }

  const jobs = [];
  if (major >= 21 && existsSync(path.join(repoDir, 'gradlew'))) {
    console.log(`🚀 Starting CloudStream plugin server on http://localhost:${port} …`);
    jobs.push(run('./gradlew', [':server-app:run'], {
      cwd: repoDir,
      env: { ...process.env, SERVER_PORT: port },
    }));
  }
  if (withDev) {
    console.log('🚀 Starting PRAHA dev server…');
    jobs.push(run('npm', ['run', 'dev'], { cwd: root }));
  }
  if (!jobs.length) process.exit(1);
  await Promise.race(jobs);
  shutdown();
}

main();
