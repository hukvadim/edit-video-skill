// Пошук зовнішніх бінарників і шляхи скіла. Windows: PATH + пакети WinGet; macOS/Linux: which (Homebrew).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const TOOL = path.resolve(import.meta.dirname, '..');
export const IS_WIN = process.platform === 'win32';
export const WHISPER_MODEL = path.join(TOOL, 'tools/models/ggml-large-v3-turbo-q5_0.bin');
export const RVM_MODEL = path.join(TOOL, 'tools/models/rvm_mobilenetv3_fp32.onnx');
export const WHOOSH = path.join(TOOL, 'tools/sfx/whoosh.mp3');

function onPath(name) {
  const r = spawnSync(IS_WIN ? 'where.exe' : 'which', [name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function findIn(dir, file, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === file) return p;
    if (e.isDirectory()) { const r = findIn(p, file, depth - 1); if (r) return r; }
  }
  return null;
}

// ffmpeg / ffprobe: PATH, а на Windows ще й пакет WinGet (PATH у поточній сесії після встановлення не оновлюється)
export function findBin(name) {
  const p = onPath(name);
  if (p) return p;
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || '';
    const link = path.join(local, 'Microsoft/WinGet/Links', name + '.exe');
    if (fs.existsSync(link)) return link;
    const pkgs = path.join(local, 'Microsoft/WinGet/Packages');
    for (const d of fs.existsSync(pkgs) ? fs.readdirSync(pkgs) : [])
      if (d.startsWith('Gyan.FFmpeg')) { const r = findIn(path.join(pkgs, d), name + '.exe'); if (r) return r; }
  }
  return null;
}

// whisper-cli: tools/whisper (Windows-реліз) або PATH (brew install whisper-cpp)
export function findWhisper() {
  return findIn(path.join(TOOL, 'tools/whisper'), IS_WIN ? 'whisper-cli.exe' : 'whisper-cli') ?? onPath('whisper-cli');
}

export function need(name, p) {
  if (!p) throw new Error(`${name} не знайдено — запусти: node "${path.join(TOOL, 'scripts/setup.mjs')}"`);
  return p;
}
