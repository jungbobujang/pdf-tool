// CHANGELOG.md → public/changelog.json (앱의 "새 소식"이 읽는다)
//   node scripts/gen-changelog.mjs          만들기 (npm run build 에서 자동)
//   node scripts/gen-changelog.mjs --check  JSON이 CHANGELOG.md와 맞는지만 확인 (verify에서)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'public', 'changelog.json');

export function parse(md) {
  const entries = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*·\s*(.+?)\s*$/);
    if (m) {
      cur = { date: m[1], title: m[2], items: [] };
      entries.push(cur);
      continue;
    }
    const it = line.match(/^-\s+(.+?)\s*$/);
    if (it && cur && cur.items.length < 3) cur.items.push(it[1]);
  }
  // 같은 날 여러 개여도 구분되게: 날짜 + 순번(아래부터)
  entries.forEach((e, i) => { e.id = `${e.date}-${entries.length - i}`; });
  return entries;
}

const entries = parse(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
const json = `${JSON.stringify({ entries }, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (now !== json) {
    console.error('public/changelog.json이 CHANGELOG.md와 달라요 → node scripts/gen-changelog.mjs');
    process.exit(1);
  }
  console.log(`새 소식 OK (${entries.length}개)`);
  process.exit(0);
}
fs.writeFileSync(OUT, json);
console.log(`새 소식: public/changelog.json (${entries.length}개)`);
