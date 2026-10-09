#!/usr/bin/env node
// Перевіряє й встановлює все, що потрібно скілу edit-video. Ідемпотентний: повторний запуск нічого не перекачує.
//   node scripts/setup.mjs           — перевірити й доставити відсутнє
//   node scripts/setup.mjs --check   — лише звіт
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TOOL, IS_WIN, WHISPER_MODEL, RVM_MODEL, WHOOSH, findBin, findWhisper } from './bins.mjs';

const CHECK = process.argv.includes('--check');
const IS_MAC = process.platform === 'darwin';
const UA = { 'User-Agent': 'edit-video-skill-setup' };
const rows = [];
const ok = (name, detail = '') => rows.push([true, name, detail]);
const bad = (name, detail) => rows.push([false, name, detail]);

// shell на Windows лише для команд з PATH (winget, npm.cmd); абсолютні шляхи (можуть мати пробіли) — без shell
const sh = (cmd, args, { quiet = false, cwd } = {}) => {
  const opts = { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit', cwd };
  return IS_WIN && !path.isAbsolute(cmd)
    ? spawnSync([cmd, ...args].join(' '), { ...opts, shell: true })
    : spawnSync(cmd, args, opts);
};

async function download(url, dest) {
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`↓ ${url}`);
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const part = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
  fs.renameSync(part, dest);
}

function step(name, fn) {
  return fn().catch((e) => bad(name, e.message.split('\n')[0]));
}

// ---------- кроки ----------
async function node() {
  const major = Number(process.versions.node.split('.')[0]);
  major >= 20 ? ok('Node.js', process.version) : bad('Node.js', `${process.version} < 20: ${IS_WIN ? 'winget install OpenJS.NodeJS.LTS' : 'brew install node'}`);
}

async function ffmpeg() {
  let ff = findBin('ffmpeg');
  if ((!ff || !findBin('ffprobe')) && !CHECK) {
    if (IS_WIN) sh('winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent']);
    else if (IS_MAC) sh('brew', ['install', 'ffmpeg']);
    ff = findBin('ffmpeg');
  }
  if (!ff || !findBin('ffprobe')) return bad('ffmpeg', IS_WIN ? 'winget install Gyan.FFmpeg' : IS_MAC ? 'brew install ffmpeg' : 'встанови ffmpeg ≥ 7 з libass');
  const ver = sh(ff, ['-version'], { quiet: true }).stdout.split('\n')[0];
  const filters = sh(ff, ['-hide_banner', '-filters'], { quiet: true }).stdout;
  const encoders = sh(ff, ['-hide_banner', '-encoders'], { quiet: true }).stdout;
  const missing = ['subtitles', 'alphamerge', 'sidechaincompress', 'loudnorm', 'silencedetect'].filter((x) => !new RegExp(`\\s${x}\\s`).test(filters));
  if (!/\slibx264\s/.test(encoders)) missing.push('libx264');
  const major = Number(ver.match(/version n?(\d+)\./)?.[1] ?? 99); // git-збірки без номера версії вважаємо свіжими
  if (major < 7) missing.push('версія ≥ 7 (потрібна для -/filter_complex)');
  missing.length ? bad('ffmpeg', `бракує: ${missing.join(', ')} — ${ver}`) : ok('ffmpeg', ver.replace('ffmpeg version ', '').split(' ')[0]);
}

async function whisper() {
  let w = findWhisper();
  if (!w && !CHECK) {
    if (IS_WIN) {
      // у найсвіжішому релізі бінарників може не бути — беремо перший, де є whisper-bin-x64.zip
      const rels = await (await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15', { headers: UA })).json();
      const asset = rels.flatMap((r) => r.assets ?? []).find((a) => a.name === 'whisper-bin-x64.zip');
      if (!asset) throw new Error('не знайдено whisper-bin-x64.zip у релізах ggml-org/whisper.cpp');
      const zip = path.join(TOOL, 'tools/whisper.zip'), dir = path.join(TOOL, 'tools/whisper');
      await download(asset.browser_download_url, zip);
      fs.mkdirSync(dir, { recursive: true });
      // системний bsdtar розпаковує zip (tar із Git — ні)
      const r = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('не вдалося розпакувати whisper.zip');
      fs.rmSync(zip);
    } else if (IS_MAC) sh('brew', ['install', 'whisper-cpp']);
    w = findWhisper();
  }
  if (!w) return bad('whisper-cli', IS_MAC ? 'brew install whisper-cpp' : 'див. README → whisper.cpp');
  const r = spawnSync(w, ['-h'], { encoding: 'utf8' });
  r.status === 0 || /usage/i.test(r.stdout + r.stderr) ? ok('whisper-cli', w) : bad('whisper-cli', `не запускається: ${w}`);
}

async function models() {
  if (!CHECK) {
    await download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin', WHISPER_MODEL);
    await download('https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx', RVM_MODEL);
  }
  for (const [f, min] of [[WHISPER_MODEL, 500e6], [RVM_MODEL, 10e6]]) {
    const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
    size > min ? ok(path.basename(f), `${(size / 1e6).toFixed(0)} МБ`) : bad(path.basename(f), 'немає — запусти setup без --check');
  }
}

async function npm() {
  const have = () => ['remotion', '@remotion/cli', 'onnxruntime-node', 'react'].every((p) => fs.existsSync(path.join(TOOL, 'node_modules', p, 'package.json')));
  if (!have() && !CHECK) sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: TOOL });
  have() ? ok('npm-пакети', 'remotion, onnxruntime-node, react') : bad('npm-пакети', `npm ci у ${TOOL}`);
}

const ortLoads = () => spawnSync(process.execPath, ['-e', "require('onnxruntime-node')"], { cwd: TOOL, encoding: 'utf8' }).status === 0;

// Старий системний VC++ Runtime (< 14.28) не має MSVCP140_ATOMIC_WAIT.dll → onnxruntime не вантажиться.
// Без змін у системі: беремо x64-копії runtime з будь-якої програми в Program Files і кладемо поруч із бінарником.
function findRuntimeDir(dir, depth = 6) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const f = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'msvcp140_atomic_wait.dll');
  if (f && isX64(path.join(dir, f.name))) return dir;
  for (const e of entries) if (e.isDirectory()) { const r = findRuntimeDir(path.join(dir, e.name), depth - 1); if (r) return r; }
  return null;
}
function isX64(file) {
  const b = fs.readFileSync(file);
  return b.readUInt16LE(b.readUInt32LE(0x3c) + 4) === 0x8664;
}

async function onnx() {
  if (!fs.existsSync(path.join(TOOL, 'node_modules/onnxruntime-node'))) return bad('onnxruntime', 'спершу npm-пакети');
  if (!ortLoads() && IS_WIN && !CHECK) {
    const bin = path.join(TOOL, 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64');
    const src = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((d) => findRuntimeDir(d)).find(Boolean);
    if (src) {
      console.log(`VC++ Runtime: копіюю DLL з ${src}`);
      for (const n of fs.readdirSync(src)) if (/^(msvcp140.*|vcruntime140.*)\.dll$/i.test(n)) fs.copyFileSync(path.join(src, n), path.join(bin, n));
    }
    if (!ortLoads()) {
      console.log('VC++ Runtime: ставлю Microsoft.VCRedist.2015+.x64 (може з\'явитися вікно UAC — його треба підтвердити)');
      sh('winget', ['install', '--id', 'Microsoft.VCRedist.2015+.x64', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent']);
    }
  }
  ortLoads() ? ok('onnxruntime', 'вантажиться') : bad('onnxruntime', IS_WIN ? 'онови VC++ Redistributable 2015–2022 x64' : 'npm ci ще раз');
}

async function chrome() {
  const cli = path.join(TOOL, 'node_modules/@remotion/cli/remotion-cli.js');
  if (!fs.existsSync(cli)) return bad('Chrome для Remotion', 'спершу npm-пакети');
  const r = CHECK ? { status: 0 } : spawnSync(process.execPath, [cli, 'browser', 'ensure'], { cwd: TOOL, stdio: 'inherit' });
  r.status === 0 ? ok('Chrome для Remotion', CHECK ? 'скачається при першому рендері' : 'готовий') : bad('Chrome для Remotion', 'remotion browser ensure впав');
}

async function sfx() {
  if (!CHECK) await download('https://assets.mixkit.co/active_storage/sfx/1489/1489-preview.mp3', WHOOSH);
  fs.existsSync(WHOOSH) ? ok('whoosh.mp3', 'Mixkit Free License') : bad('whoosh.mp3', 'не обов\'язково: вставки підуть без звуку переходу');
}

async function font() {
  const f = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts', 'seguibl.ttf') : path.join(TOOL, 'fonts/Montserrat-Black.ttf');
  fs.existsSync(f) ? ok('шрифт', path.basename(f)) : bad('шрифт', `немає ${f}`);
}

// ---------- запуск ----------
console.log(`edit-video setup ${CHECK ? '(лише перевірка)' : ''} — ${TOOL}\n`);
for (const [name, fn] of [['Node.js', node], ['ffmpeg', ffmpeg], ['whisper-cli', whisper], ['моделі', models], ['npm-пакети', npm],
  ['onnxruntime', onnx], ['Chrome для Remotion', chrome], ['whoosh.mp3', sfx], ['шрифт', font]]) await step(name, fn);

console.log('\n' + rows.map(([good, n, d]) => `${good ? '✅' : '❌'} ${n.padEnd(30)} ${d}`).join('\n'));
const failed = rows.filter((r) => !r[0] && r[1] !== 'whoosh.mp3');
console.log(failed.length ? `\nНе готово: ${failed.length}. Виправ пункти з ❌ і запусти ще раз.` : '\nВсе готово до монтажу.');
// не process.exit(): на Windows він валить Node (UV_HANDLE_CLOSING), поки fetch ще тримає з'єднання
process.exitCode = failed.length ? 1 : 0;
