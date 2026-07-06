// Branch-guarded Railway deploys:
//   npm run deploy:prod     -> service "videorouter"          only from branch master
//   npm run deploy:staging  -> service "videorouter-staging"  only from branch orbitq
// `railway up` ships the working directory, so the guard also refuses dirty trees.
import { execSync, spawnSync } from 'node:child_process';

const TARGETS = {
  prod: { branch: 'master', service: 'videorouter' },
  staging: { branch: 'orbitq', service: 'videorouter-staging' },
};

const target = TARGETS[process.argv[2]];
if (!target) {
  console.error('usage: node scripts/deploy.mjs <prod|staging>');
  process.exit(1);
}

const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
if (branch !== target.branch) {
  console.error(`Refusing: "${process.argv[2]}" deploys only from branch "${target.branch}" — you are on "${branch}".`);
  process.exit(1);
}
if (execSync('git status --porcelain').toString().trim()) {
  console.error('Refusing: uncommitted changes present. Commit first — railway up ships the working directory as-is.');
  process.exit(1);
}

console.log(`Deploying branch "${branch}" -> Railway service "${target.service}"…`);
const r = spawnSync('npx', ['-y', '@railway/cli', 'up', '--service', target.service, '--detach'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
