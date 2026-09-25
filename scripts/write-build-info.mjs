// 배포 직전에 현재 커밋과 시각을 build-info.json에 적는다.
// `railway up`은 .git 폴더를 올리지 않고 RAILWAY_GIT_COMMIT_SHA도 주지 않으므로,
// 서버의 /version은 이 파일로 지금 돌고 있는 커밋을 알려 준다.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

let commit = 'dev';
let dirty = false;
try {
  commit = git('rev-parse --short=7 HEAD');
  dirty = git('status --porcelain --untracked-files=no').length > 0;
} catch {
  console.warn('git 정보를 읽지 못해 commit을 "dev"로 적어요.');
}

const info = { commit, dirty, builtAt: new Date().toISOString() };
writeFileSync(path.join(root, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info.json: ${info.commit}${dirty ? ' (커밋 안 된 변경 있음)' : ''} · ${info.builtAt}`);
