// Маска людини через Robust Video Matting (ONNX): кадри RGB з ffmpeg → альфа → matte.mkv (gray, ffv1)
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import ort from 'onnxruntime-node';
import { RVM_MODEL } from './bins.mjs';

// decodeArgs: аргументи ffmpeg, що віддають у stdout rawvideo rgb24 розміром w×h.
// ranges: [[кадр_від, кадр_до], ...] — де маска потрібна; поза ними пишемо чорне (на CPU RVM ~1–3 fps).
export async function makeMatte(ffmpeg, decodeArgs, out, { w, h, fps, ratio = 0.5, cwd, ranges }) {
  const need = (i) => !ranges || ranges.some(([a, b]) => i >= a && i <= b);
  const sess = await ort.InferenceSession.create(RVM_MODEL, { intraOpNumThreads: os.availableParallelism() });
  const dec = spawn(ffmpeg, decodeArgs, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  const enc = spawn(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(fps),
    '-i', '-', '-c:v', 'ffv1', out], { stdio: ['pipe', 'inherit', 'inherit'] });

  const frameSize = w * h * 3, n = w * h;
  const src = new Float32Array(3 * n);
  const zeros = () => Object.fromEntries(['r1i', 'r2i', 'r3i', 'r4i'].map((k) => [k, new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1])]));
  let rec = zeros();
  const dr = new ort.Tensor('float32', new Float32Array([ratio]), [1]);
  const black = Buffer.alloc(n);
  let buf = Buffer.alloc(0), frames = 0, done = 0;
  const t0 = Date.now();

  for await (const chunk of dec.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= frameSize) {
      let a = black;
      if (need(frames)) {
        if (!need(frames - 1)) rec = zeros(); // новий діапазон — чистий рекурентний стан
        const f = buf.subarray(0, frameSize);
        for (let i = 0; i < n; i++) { src[i] = f[3 * i] / 255; src[n + i] = f[3 * i + 1] / 255; src[2 * n + i] = f[3 * i + 2] / 255; }
        const r = await sess.run({ src: new ort.Tensor('float32', src, [1, 3, h, w]), ...rec, downsample_ratio: dr });
        rec = { r1i: r.r1o, r2i: r.r2o, r3i: r.r3o, r4i: r.r4o };
        const pha = r.pha.data;
        a = Buffer.allocUnsafe(n);
        for (let i = 0; i < n; i++) a[i] = Math.max(0, Math.min(255, Math.round(pha[i] * 255)));
        if (++done % 30 === 0) process.stdout.write(`\rмаска: ${done} кадрів, ${(done / ((Date.now() - t0) / 1000)).toFixed(1)} fps`);
      }
      if (!enc.stdin.write(a)) await once(enc.stdin, 'drain');
      buf = Buffer.from(buf.subarray(frameSize));
      frames++;
    }
  }
  enc.stdin.end();
  const [code] = await once(enc, 'close');
  if (code !== 0) throw new Error('ffmpeg (маска) впав');
  console.log(`\rмаска: ${done} з ${frames} кадрів пораховано за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  return frames;
}
