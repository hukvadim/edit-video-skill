#!/usr/bin/env node
// Конвеєр монтажу: prep <video> | preview <edit.json> | render <edit.json> | selftest
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { TOOL, IS_WIN, WHISPER_MODEL, WHOOSH, findBin, findWhisper, need } from './bins.mjs';

// TOOL — папка скіла (моделі, node_modules, motion). Проєкт — папка з відео: work/, out/, assets/.
const FPS = 30;
const ACCENT = '&H0000D2FF'; // #FFD200 у форматі ASS (BGR)
// Windows: системний Segoe UI Black; macOS/Linux: Montserrat Black з fonts/ (OFL), обидва з кирилицею
const FONT = IS_WIN ? 'Segoe UI Black' : 'Montserrat Black';

// ---------- утиліти ----------
let _ff, _fp;
const ffmpeg = () => (_ff ??= need('ffmpeg', findBin('ffmpeg')));
const ffprobe = () => (_fp ??= need('ffprobe', findBin('ffprobe')));

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} впав:\n${(r.stderr || '').slice(-3000)}`);
  return r;
}

const r2 = (x) => Math.round(x * 100) / 100;
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const workDir = (video) => path.join(path.dirname(video), 'work', path.parse(video).name);

// ---------- prep ----------
function probe(video) {
  const j = JSON.parse(run(ffprobe(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]).stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const rot = Number(v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0);
  const swap = Math.abs(rot) % 180 === 90;
  const [n, d] = v.r_frame_rate.split('/').map(Number);
  return {
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    fps: n / d,
    duration: Number(j.format.duration),
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}

function prep(video, lang = 'auto') {
  video = path.resolve(video);
  const dir = workDir(video);
  fs.mkdirSync(dir, { recursive: true });
  const info = probe(video);
  fs.writeFileSync(path.join(dir, 'probe.json'), JSON.stringify(info, null, 2));
  console.log('probe:', info);

  const wav = path.join(dir, 'audio16k.wav');
  run(ffmpeg(), ['-y', '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);

  console.log('whisper… (на слабкому CPU це кілька хвилин)');
  run(need('whisper-cli', findWhisper()), ['-m', WHISPER_MODEL, '-l', lang, '-t', String(os.availableParallelism()),
    '-ml', '1', '-sow', '-oj', '-of', path.join(dir, 'whisper'), '-f', wav]);
  const wj = JSON.parse(fs.readFileSync(path.join(dir, 'whisper.json'), 'utf8'));
  const words = wj.transcription
    .map((t) => ({ s: t.offsets.from / 1000, e: t.offsets.to / 1000, w: t.text.trim() }))
    .filter((x) => x.w && !/^[[(].*[\])]$/.test(x.w));
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify({ lang: wj.result?.language, words }, null, 1));

  const sd = run(ffmpeg(), ['-v', 'info', '-i', wav, '-af', 'silencedetect=n=-30dB:d=0.2', '-f', 'null', '-']).stderr;
  const starts = [...sd.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...sd.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const silences = starts.map((s, i) => ({ s, e: ends[i] ?? info.duration }));
  fs.writeFileSync(path.join(dir, 'silences.json'), JSON.stringify(silences, null, 1));

  // фрази для читання: розрив на паузі > 0.6 с або кінці речення
  let line = [];
  const flush = () => line.length && console.log(`[${line[0].s.toFixed(2)}–${line.at(-1).e.toFixed(2)}] ${line.map((x) => x.w).join(' ')}`);
  for (const [i, w] of words.entries()) {
    if (line.length && (w.s - line.at(-1).e > 0.6 || /[.?!…]$/.test(line.at(-1).w))) { flush(); line = []; }
    line.push(w);
    if (i === words.length - 1) flush();
  }
  console.log(`\nпауз: ${silences.length}. Файли в ${dir}`);
}

// ---------- перерахунок часу ----------
function snapSegments(segments, fps) {
  let off = 0;
  return segments.map((g) => {
    const start = Math.round(g.start * fps) / fps;
    const end = Math.round(g.end * fps) / fps;
    const seg = { ...g, start, end, off };
    off += end - start;
    return seg;
  });
}

function mapTime(segs, t) {
  const g = segs.find((x) => t >= x.start && t < x.end);
  return g ? g.off + t - g.start : null;
}

function mapWords(segs, words) {
  const out = [];
  for (const g of segs)
    for (const w of words) {
      const mid = (w.s + w.e) / 2;
      if (mid >= g.start && mid < g.end)
        out.push({ s: g.off + Math.max(w.s, g.start) - g.start, e: g.off + Math.min(w.e, g.end) - g.start, w: w.w });
    }
  return out;
}

// whisper на початку фраз часто дає слова нульової довжини, ще й у паузі.
// Зсуваємо старт із паузи на її кінець і розтягуємо «злиплі» слова пропорційно довжині.
function retime(words, silences) {
  const w = words.map((x) => {
    const sil = silences.find((s) => x.s >= s.s && x.s < s.e);
    const s = sil ? sil.e : x.s;
    return { ...x, s, e: Math.max(x.e, s) };
  });
  for (let i = 0; i < w.length; i++) {
    let j = i;
    while (j < w.length - 1 && w[j].e - w[j].s < 0.06) j++;
    if (j === i) continue;
    const run = w.slice(i, j + 1), a = run[0].s, b = run.at(-1).e;
    const total = run.reduce((n, x) => n + x.w.length, 0);
    let t = a;
    for (const x of run) { x.s = t; t += ((b - a) * x.w.length) / total; x.e = t; }
    i = j;
  }
  return w;
}

// ---------- ASS ----------
const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assEsc = (s) => s.replace(/[{}]/g, '').replace(/\\/g, '').replace(/\n/g, '\\N');
const subWord = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}?!%]+$/gu, '').toUpperCase();

function chunkWords(words, maxWords = 3, maxChars = 16) {
  const chunks = [];
  let cur = [];
  for (const w of words) {
    const prev = cur.at(-1);
    const chars = cur.reduce((n, x) => n + x.w.length + 1, 0);
    if (prev && (cur.length >= maxWords || chars + w.w.length > maxChars || w.s - prev.e > 0.6 || /[.?!…,:;]$/.test(prev.w))) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function buildAss(edit, segs, words, total) {
  const st = { subY: 520, calloutY: 330, titleY: 360, ...edit.style };
  const ev = [];
  const dlg = (s, e, style, text) => ev.push(`Dialogue: 0,${assTime(s)},${assTime(e)},${style},,0,0,0,,${text}`);

  // розбиваємо по сирому тексту (там ще є коми/крапки), а показуємо очищений
  const chunks = chunkWords(mapWords(segs, words).filter((w) => subWord(w.w)))
    .map((c) => c.map((w) => ({ ...w, w: subWord(w.w) })));
  chunks.forEach((c, ci) => {
    const nextStart = chunks[ci + 1]?.[0].s ?? total;
    c.forEach((w, j) => {
      const s = j === 0 ? w.s : w.s;
      const e = j < c.length - 1 ? c[j + 1].s : Math.min(w.e + 0.25, nextStart);
      const text = c.map((x, k) => k === j
        ? `{\\c${ACCENT}&\\fscx118\\fscy118\\t(0,90,\\fscx100\\fscy100)}${assEsc(x.w)}{\\r}`
        : assEsc(x.w)).join(' ');
      dlg(s, Math.max(e, s + 0.05), 'Sub', text);
    });
  });

  if (edit.title?.text) {
    const d = edit.title.dur ?? 2.5;
    dlg(0.05, d, 'Title', `{\\pos(540,${st.titleY})\\fad(150,250)\\fscx70\\fscy70\\t(0,220,\\fscx100\\fscy100)}${assEsc(edit.title.text)}`);
  }
  for (const c of edit.callouts ?? []) {
    const t = mapTime(segs, c.at);
    if (t == null) { console.warn('плашка у вирізаному шматку, пропускаю:', c.text); continue; }
    const y = c.y ?? st.calloutY;
    const text = assEsc(c.text).replace(/\*([^*]+)\*/g, `{\\c${ACCENT}&}$1{\\r}`);
    dlg(t, Math.min(t + (c.dur ?? 2), total), 'Callout', `{\\move(1500,${y},540,${y},0,260)\\fad(0,200)}${text}`);
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${FONT},82,&H00FFFFFF,&H000000FF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,1,7,3,2,80,80,${st.subY},1
Style: Title,${FONT},96,&H00141414,&H000000FF,&HFF000000,${ACCENT},0,0,0,0,100,100,0,0,4,28,0,5,90,90,0,1
Style: Callout,${FONT},76,&H00FFFFFF,&H000000FF,&HFF000000,&H28141414,0,0,0,0,100,100,0,0,4,24,0,5,110,110,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev.join('\n')}
`;
}

// ---------- граф ffmpeg ----------
function cropBox(src, cropX = 0.5, zoom = 1) {
  const a = 9 / 16;
  let bw = src.width, bh = src.height, bx = 0, by = 0;
  if (src.width / src.height > a) { bw = src.height * a; bx = (src.width - bw) * cropX; }
  else { bh = src.width / a; by = (src.height - bh) * 0.5; }
  const w = bw / zoom, h = bh / zoom;
  return { w: even(w), h: even(h), x: even(bx + (bw - w) / 2), y: even(by + (bh - h) * 0.4) };
}

// координати в просторі 1080×1920 (S — розмір іконки там же)
const ICON_POS = {
  'top-right': (S) => [1080 - S - 60, 250],
  'top-left': () => [60, 250],
  'top-center': (S) => [(1080 - S) / 2, 230],
  'mid-right': (S) => [1080 - S - 50, 760],
  'mid-left': () => [50, 760],
};

const segVideo = (g, i, src, edit, W, H) => {
  const c = cropBox(src, edit.cropX ?? 0.5, g.zoom ?? 1);
  return `[v${i}]trim=start=${g.start}:end=${g.end},setpts=PTS-STARTPTS,crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${W}:${H}:flags=lanczos,setsar=1,fps=${FPS}[sv${i}]`;
};

// лише склейки + zoom, без звуку й накладань — вхід для маски людини
function baseGraph({ edit, segs, src, W, H }) {
  return [`[0:v]split=${segs.length}${segs.map((_, i) => `[v${i}]`).join('')}`,
    ...segs.map((g, i) => segVideo(g, i, src, edit, W, H)),
    `${segs.map((_, i) => `[sv${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,format=rgb24[vb]`].join(';\n');
}

function buildGraph({ edit, segs, src, total, W, H, audioOnly, voiceGainDb = 0, icons = [], musicIdx, brolls = [], matteIdx, cutaways = [] }) {
  const N = segs.length;
  const f = [];
  const k = W / 1080;
  f.push(`[0:a]asplit=${N}${segs.map((_, i) => `[a${i}]`).join('')}`);
  if (!audioOnly) f.push(`[0:v]split=${N}${segs.map((_, i) => `[v${i}]`).join('')}`);
  segs.forEach((g, i) => {
    const d = g.end - g.start;
    f.push(`[a${i}]atrim=start=${g.start}:end=${g.end},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, d - 0.02).toFixed(3)}:d=0.02[sa${i}]`);
    if (!audioOnly) f.push(segVideo(g, i, src, edit, W, H));
  });
  if (audioOnly) f.push(`${segs.map((_, i) => `[sa${i}]`).join('')}concat=n=${N}:v=0:a=1[ac]`);
  else f.push(`${segs.map((_, i) => `[sv${i}][sa${i}]`).join('')}concat=n=${N}:v=1:a=1[vc][ac]`);

  const voice = `highpass=f=80,afftdn=nf=-25,equalizer=f=3000:t=q:w=1:g=2,acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2`;
  if (audioOnly) { f.push(`[ac]${voice},loudnorm=print_format=json[aout]`); return f.join(';\n'); }

  const fadeA = `afade=t=in:d=0.15,afade=t=out:st=${(total - 0.4).toFixed(3)}:d=0.4`;
  const extras = [];
  f.push(`[ac]${voice},volume=${voiceGainDb.toFixed(2)}dB${musicIdx != null ? ',asplit[vo][vsc]' : '[vo]'}`);
  if (musicIdx != null) {
    // м'яке приглушення: пауз після монтажу майже немає, тож музика має жити й під голосом (~−14 дБ від нього)
    f.push(`[${musicIdx}:a]atrim=0:${total.toFixed(3)},volume=${edit.music.volume ?? 0.3},afade=t=in:d=1,afade=t=out:st=${(total - 1.5).toFixed(3)}:d=1.5[mus]`);
    f.push(`[mus][vsc]sidechaincompress=threshold=0.05:ratio=3:attack=30:release=500[duck]`);
    extras.push('[duck]');
  }
  cutaways.forEach((c, i) => {
    if (c.sfxIdx == null) return;
    const ms = Math.round(Math.max(0, c.t - 0.2) * 1000);
    f.push(`[${c.sfxIdx}:a]adelay=delays=${ms}:all=1,volume=0.5[sfx${i}]`);
    extras.push(`[sfx${i}]`);
  });
  f.push(extras.length
    ? `[vo]${extras.join('')}amix=inputs=${1 + extras.length}:duration=first:normalize=0,alimiter=limit=0.84:level=disabled,${fadeA}[aout]`
    : `[vo]alimiter=limit=0.84:level=disabled,${fadeA}[aout]`);

  f.push(`[vc]eq=contrast=1.05:saturation=1.12:brightness=0.01[ve]`);
  let last = 've';
  if (brolls.length) {
    // фон → картки b-roll → людина (те саме відео з маскою RVM) поверх
    f.push(`[ve]split[bg0][fg]`);
    brolls.forEach((b, i) => {
      f.push(`[${b.idx}:v]setpts=PTS-STARTPTS+${b.t.toFixed(3)}/TB[br${i}]`);
      f.push(`[bg${i}][br${i}]overlay=eof_action=pass:format=auto[bg${i + 1}]`);
    });
    f.push(`[${matteIdx}:v]scale=${W}:${H},format=gray[mt]`);
    f.push(`[fg][mt]alphamerge[person]`);
    f.push(`[bg${brolls.length}][person]overlay=format=auto[vp]`);
    last = 'vp';
  }
  // повноекранні стокові вставки: cover-кроп у 9:16, повільна панорама, перехід через прозорість 0.25 с
  cutaways.forEach((c, i) => {
    const fit = c.width / c.height > W / H ? `scale=-2:${even(H * 1.08)}` : `scale=${even(W * 1.08)}:-2`;
    const d = c.dur.toFixed(3);
    f.push(`[${c.idx}:v]fps=${FPS},${fit},crop=${W}:${H}:x='(iw-ow)*${c.cropX ?? 0.5}':y='(ih-oh)*(0.2+0.6*t/${d})',setsar=1,` +
      `eq=contrast=1.04:saturation=1.08,format=yuva420p,fade=t=in:d=0.25:alpha=1,fade=t=out:st=${(c.dur - 0.25).toFixed(3)}:d=0.25:alpha=1,` +
      `setpts=PTS-STARTPTS+${c.t.toFixed(3)}/TB[cw${i}]`);
    f.push(`[${last}][cw${i}]overlay=eof_action=pass:format=auto[cut${i}]`);
    last = `cut${i}`;
  });
  icons.forEach((ic, i) => {
    const S0 = ic.size ?? 240;
    const S = Math.round(S0 * k);
    const [x, y] = (ICON_POS[ic.pos] ?? ICON_POS['top-right'])(S0).map((v) => Math.round(v * k));
    const fo = Math.max(0, ic.dur - 0.25).toFixed(2);
    f.push(`[${ic.idx}:v]format=rgba,scale=${S}:-1,fade=t=in:d=0.25:alpha=1,fade=t=out:st=${fo}:d=0.25:alpha=1,setpts=PTS-STARTPTS+${ic.t.toFixed(3)}/TB[ic${i}]`);
    f.push(`[${last}][ic${i}]overlay=x=${x}:y='${y}+40*max(0,1-(t-${ic.t.toFixed(3)})/0.3)':enable='between(t,${ic.t.toFixed(3)},${(ic.t + ic.dur).toFixed(3)})':eof_action=pass[vi${i}]`);
    last = `vi${i}`;
  });
  const fontsdir = IS_WIN ? '' : `:fontsdir='${path.join(TOOL, 'fonts')}'`;
  f.push(`[${last}]subtitles=subs.ass${fontsdir},fade=t=in:d=0.3,fade=t=out:st=${(total - 0.4).toFixed(3)}:d=0.4,format=yuv420p[vout]`);
  return f.join(';\n');
}

// ---------- render ----------
let _qsv;
function hasQsv() {
  if (_qsv != null) return _qsv;
  if (!IS_WIN) return (_qsv = false);
  const r = spawnSync(ffmpeg(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', 'h264_qsv', '-f', 'null', '-']);
  return (_qsv = r.status === 0);
}

const sha = (x) => createHash('sha1').update(x).digest('hex').slice(0, 10);

// прозорий кліп Remotion (ProRes 4444); картинки беруться з <проєкт>/assets/covers; кеш за props + кодом композиції
function renderBroll(dir, project, props) {
  const code = fs.readFileSync(path.join(TOOL, 'motion/Broll.tsx'), 'utf8');
  const file = path.join(dir, `broll_${sha(JSON.stringify(props) + code)}.mov`);
  if (fs.existsSync(file)) return file;
  const propsFile = file.replace(/\.mov$/, '.json');
  fs.writeFileSync(propsFile, JSON.stringify(props));
  console.log(`b-roll ${props.layout} (${props.dur} с)…`);
  run(process.execPath, [path.join(TOOL, 'node_modules/@remotion/cli/remotion-cli.js'), 'render', 'motion/index.ts', 'Broll', file,
    `--props=${propsFile}`, '--codec=prores', '--prores-profile=4444', '--image-format=png', '--pixel-format=yuva444p10le',
    `--public-dir=${path.join(project, 'assets')}`, '--log=error'], { cwd: TOOL });
  return file;
}

// маска людини 432×768 лише на відрізках b-roll (+0.5 с розгону RVM); кеш за склейками й відрізками
async function ensureMatte(dir, source, edit, segs, src, brolls) {
  const ranges = brolls.map((b) => [Math.max(0, Math.floor((b.t - 0.5) * FPS)), Math.ceil((b.t + b.dur) * FPS)]);
  const file = path.join(dir, `matte_${sha(JSON.stringify([edit.source, edit.cropX, segs, ranges]))}.mkv`);
  if (fs.existsSync(file)) return file;
  const [w, h] = [432, 768];
  fs.writeFileSync(path.join(dir, 'graph_base.txt'), baseGraph({ edit, segs, src, W: w, H: h }));
  const { makeMatte } = await import('./matte.mjs');
  await makeMatte(ffmpeg(), ['-v', 'error', '-i', source, '-/filter_complex', 'graph_base.txt', '-map', '[vb]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    file + '.tmp.mkv', { w, h, fps: FPS, cwd: dir, ranges });
  fs.renameSync(file + '.tmp.mkv', file);
  return file;
}

async function render(editPath, preview) {
  editPath = path.resolve(editPath);
  const dir = path.dirname(editPath);
  const edit = JSON.parse(fs.readFileSync(editPath, 'utf8'));
  const project = path.resolve(dir, '..', '..'); // <проєкт>/work/<назва>/edit.json
  const source = path.resolve(project, edit.source);
  const src = JSON.parse(fs.readFileSync(path.join(dir, 'probe.json'), 'utf8'));
  const words = retime(JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')).words,
    JSON.parse(fs.readFileSync(path.join(dir, 'silences.json'), 'utf8')));
  const segs = snapSegments(edit.segments, src.fps);
  const total = segs.at(-1).off + segs.at(-1).end - segs.at(-1).start;
  const [W, H] = preview ? [540, 960] : [1080, 1920];

  fs.writeFileSync(path.join(dir, 'subs.ass'), '\ufeff' + buildAss(edit, segs, words, total));

  // прохід 1: міряємо гучність голосу після обробки → підганяємо до -14 LUFS
  fs.writeFileSync(path.join(dir, 'graph_audio.txt'), buildGraph({ edit, segs, src, total, W, H, audioOnly: true }));
  const m = run(ffmpeg(), ['-hide_banner', '-i', source, '-/filter_complex', 'graph_audio.txt', '-map', '[aout]', '-f', 'null', '-'], { cwd: dir }).stderr;
  const meas = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1));
  const voiceGainDb = -14 - Number(meas.input_i);
  console.log(`голос: ${meas.input_i} LUFS → підсилення ${voiceGainDb.toFixed(1)} дБ`);

  const inputs = ['-i', source];
  let idx = 1;
  const icons = [];
  for (const ic of edit.icons ?? []) {
    const t = mapTime(segs, ic.at);
    const file = path.resolve(project, ic.file);
    if (t == null || !fs.existsSync(file)) { console.warn('іконку пропущено:', ic.file); continue; }
    const dur = Math.min(ic.dur ?? 1.5, total - t);
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', file);
    icons.push({ ...ic, t, dur, idx: idx++ });
  }
  const brolls = [];
  let matteIdx;
  for (const b of edit.broll ?? []) {
    const t = mapTime(segs, b.at);
    if (t == null) { console.warn('b-roll у вирізаному шматку, пропускаю:', b.at); continue; }
    const dur = r2(Math.min(b.dur ?? 3, total - t));
    inputs.push('-i', renderBroll(dir, project, { layout: b.layout, images: b.images, site: edit.site ?? '', avoid: edit.avoid, dur, w: W, h: H }));
    brolls.push({ t, dur, idx: idx++ });
  }
  if (brolls.length) {
    inputs.push('-i', await ensureMatte(dir, source, edit, segs, src, brolls));
    matteIdx = idx++;
  }
  const cutaways = [];
  const whoosh = edit.whoosh ? path.resolve(project, edit.whoosh)
    : [path.join(project, 'assets/sfx/whoosh.mp3'), WHOOSH].find((p) => fs.existsSync(p)) ?? '';
  for (const c of edit.cutaways ?? []) {
    const t = mapTime(segs, c.at);
    const file = path.resolve(project, c.file);
    if (t == null || !fs.existsSync(file)) { console.warn('вставку пропущено:', c.file); continue; }
    const dur = Math.min(c.dur ?? 3, total - t);
    const { width, height } = probe(file);
    inputs.push('-ss', String(c.from ?? 0), '-t', dur.toFixed(3), '-i', file);
    const cut = { ...c, t, dur, width, height, idx: idx++ };
    if (fs.existsSync(whoosh)) { inputs.push('-i', whoosh); cut.sfxIdx = idx++; }
    cutaways.push(cut);
  }
  let musicIdx = null;
  if (edit.music?.file && fs.existsSync(path.resolve(project, edit.music.file))) {
    inputs.push('-stream_loop', '-1', '-i', path.resolve(project, edit.music.file));
    musicIdx = idx++;
  } else if (edit.music?.file) console.warn('музику не знайдено, рендер без неї:', edit.music.file);

  fs.writeFileSync(path.join(dir, 'graph.txt'), buildGraph({ edit, segs, src, total, W, H, voiceGainDb, icons, musicIdx, brolls, matteIdx, cutaways }));
  const name = path.parse(edit.source).name;
  const out = preview ? path.join(dir, 'preview.mp4') : path.join(project, 'out', `${name}_final.mp4`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const venc = preview ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28']
    : hasQsv() ? ['-c:v', 'h264_qsv', '-global_quality', '22', '-preset', 'slow']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  console.log(`рендер ${W}x${H}, ${total.toFixed(1)} с, ${venc[1]}…`);
  run(ffmpeg(), ['-y', '-hide_banner', '-v', 'error', '-stats', ...inputs, '-/filter_complex', 'graph.txt',
    '-map', '[vout]', '-map', '[aout]', ...venc, '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', out], { cwd: dir, stdio: ['ignore', 'inherit', 'pipe'] });

  if (preview) {
    // тестові кадри: титул, плашки, іконки + рівномірно по таймлайну
    const times = [...brolls.map((b) => Math.min(b.t + 0.8, total - 0.1)), ...cutaways.map((c) => c.t + c.dur / 2), Math.min(1, total / 2), ...(edit.callouts ?? []).map((c) => mapTime(segs, c.at)).filter((t) => t != null).map((t) => t + 0.6),
      ...icons.map((i) => i.t + 0.5), ...[0.3, 0.55, 0.8].map((p) => p * total)].slice(0, 12);
    for (const f of fs.readdirSync(dir)) if (/^frame_\d+\.png$/.test(f)) fs.rmSync(path.join(dir, f));
    times.forEach((t, i) => run(ffmpeg(), ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', out, '-frames:v', '1', path.join(dir, `frame_${String(i).padStart(2, '0')}.png`)]));
    console.log('кадри:', times.map((t) => t.toFixed(1)).join(', '));
  } else {
    const e = run(ffmpeg(), ['-hide_banner', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-']).stderr;
    const I = e.match(/I:\s+(-?[\d.]+) LUFS(?![\s\S]*I:\s)/)?.[1], P = e.match(/Peak:\s+(-?[\d.]+) dBFS(?![\s\S]*Peak:)/)?.[1];
    console.log(`готово: ${out}\nгучність ${I} LUFS, true peak ${P} dBFS`);
  }
}

// ---------- selftest ----------
function selftest() {
  const segs = snapSegments([{ start: 1, end: 3 }, { start: 5, end: 6 }], 30);
  assert.equal(mapTime(segs, 2), 1);
  assert.equal(mapTime(segs, 5.5), 2.5);
  assert.equal(mapTime(segs, 4), null);
  const w = mapWords(segs, [{ s: 0.9, e: 1.4, w: 'а' }, { s: 3.5, e: 4, w: 'вирізано' }, { s: 5.8, e: 6.3, w: 'кінець' }]);
  assert.deepEqual(w.map((x) => [r2(x.s), r2(x.e), x.w]), [[0, 0.4, 'а']]); // середина 6.05 > кінця сегмента
  assert.equal(workDir(path.resolve('/videos/VID_1.mp4')), path.resolve('/videos/work/VID_1')); // work/ поруч із відео
  assert.equal(subWord('«привіт,'), 'ПРИВІТ');
  assert.equal(subWord('так?'), 'ТАК?');
  assert.equal(chunkWords([1, 2, 3, 4].map((i) => ({ s: i, e: i + 0.5, w: 'ab' }))).length, 2);
  const tg = buildAss({}, snapSegments([{ start: 0, end: 9 }], 30), ['Telegram,', 'будемо', 'кодити'].map((w, i) => ({ s: i, e: i + 0.9, w })), 9);
  assert.match(tg, /,Sub,,0,0,0,,\{[^}]*\}TELEGRAM\{\\r\}$/m); // кома розриває рядок перед «будемо»
  assert.equal(assTime(3725.456), '1:02:05.46');
  const ass = buildAss({ title: { text: 'Hi {x}' }, callouts: [{ at: 2, text: 'є *ідея*' }] }, segs, [{ s: 1.1, e: 1.5, w: 'слово' }], 3);
  assert.match(ass, /Dialogue: 0,0:00:00.10,0:00:00.75,Sub,.*СЛОВО/);
  assert.match(ass, /Title,,0,0,0,,.*Hi x$/m);
  assert.match(ass, /Callout.*є \{\\c&H0000D2FF&\}ідея\{\\r\}/);
  const rt = retime([['ab', 27.9, 27.9], ['abcd', 27.9, 27.9], ['xy', 27.99, 29.36], ['z', 29.8, 30]].map(([w, s, e]) => ({ w, s, e })), [{ s: 27, e: 28.2 }]);
  assert.deepEqual(rt.map((x) => r2(x.s)), [28.2, 28.49, 29.07, 29.8]);
  assert.equal(r2(rt[2].e), 29.36);
  const c = cropBox({ width: 1920, height: 1080 }, 0.5, 1);
  assert.deepEqual([c.w, c.h, c.x], [608, 1080, 656]);
  const g = buildGraph({ edit: {}, segs, src: { width: 1080, height: 1920 }, total: 3, W: 540, H: 960, brolls: [{ t: 1.5, idx: 1 }], matteIdx: 2 });
  assert.match(g, /\[1:v\]setpts=PTS-STARTPTS\+1\.500\/TB\[br0\]/);
  assert.match(g, /\[2:v\]scale=540:960,format=gray\[mt\];\n\[fg\]\[mt\]alphamerge\[person\];\n\[bg1\]\[person\]overlay/);
  const gc = buildGraph({ edit: { music: {} }, segs, src: { width: 1080, height: 1920 }, total: 3, W: 540, H: 960, musicIdx: 3,
    cutaways: [{ t: 1, dur: 1.5, width: 1280, height: 720, idx: 1, sfxIdx: 2, cropX: 0.6 }] });
  assert.match(gc, /\[1:v\]fps=30,scale=-2:1036,crop=540:960:x='\(iw-ow\)\*0\.6'/);
  assert.match(gc, /\[ve\]\[cw0\]overlay=eof_action=pass:format=auto\[cut0\];\n\[cut0\]subtitles/);
  assert.match(gc, /\[2:a\]adelay=delays=800:all=1/);
  assert.match(gc, /\[vo\]\[duck\]\[sfx0\]amix=inputs=3/);
  assert.match(baseGraph({ edit: {}, segs, src: { width: 1080, height: 1920 }, W: 720, H: 1280 }), /concat=n=2:v=1:a=0,format=rgb24\[vb\]$/);
  console.log('selftest ok');
}

const [cmd, arg, ...rest] = process.argv.slice(2);
if (cmd === 'prep' && arg) prep(arg, rest[0]);
else if (cmd === 'preview' && arg) await render(arg, true);
else if (cmd === 'render' && arg) await render(arg, false);
else if (cmd === 'selftest') selftest();
else console.log('usage: node pipeline/vid.mjs prep <video> [lang] | preview <edit.json> | render <edit.json> | selftest');
