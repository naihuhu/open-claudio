// One-off diagnostic: what does THIS logged-in account actually get for a song id, per quality tier?
// Run: npx tsx scripts/diag-songurl.ts [songId]
import neteaseApi from '@neteasecloudmusicapienhanced/api';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const api: any = (neteaseApi as any).default || neteaseApi;
const _require = createRequire(import.meta.url);

const songId = process.argv[2] || '167705';
const sessionPath = path.join(
  process.env.CLAUDIO_MUSIC_DIR || process.env.CLAUDIO_DIR || path.join(os.homedir(), '.claudio'),
  'user_session.json',
);

async function main() {
  // bootstrap xeapi config (same as server)
  try {
    const generateConfig = _require('@neteasecloudmusicapienhanced/api/generateConfig');
    await generateConfig();
  } catch (e: any) {
    console.log('generateConfig warn:', e.message);
  }

  const cookie = JSON.parse(fs.readFileSync(sessionPath, 'utf-8')).cookie;
  console.log('cookie len:', cookie?.length, '| song:', songId, '\n');

  for (const level of ['exhigh', 'standard', 'lossless', 'higher']) {
    try {
      const r = await api.song_url_v1({ id: songId, level, cookie });
      const d = r.body?.data?.[0] || {};
      console.log(`level=${level}`.padEnd(18), {
        code: r.body?.code,
        fee: d.fee,
        trial: !!d.freeTrialInfo,
        freeTrialInfo: d.freeTrialInfo || null,
        time_ms: d.time,
        size: d.size,
        br: d.br,
        url: d.url ? d.url.slice(0, 80) + '...' : null,
      });
    } catch (e: any) {
      console.log(`level=${level}`.padEnd(18), 'ERROR:', e.message);
    }
  }
}
main();
