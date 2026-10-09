import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

export type BrollProps = {
  layout: 'fan' | 'fly' | 'wall'; images: string[]; dur: number; w: number; h: number;
  site?: string;                                // підпис в адресному рядку картки ('' — без нього)
  avoid?: [number, number, number, number];     // [x, y, w, h]: предмет перед спікером (мікрофон) — картки туди не заходять
};
const Site = React.createContext('');

// Усі координати в просторі 1080×1920; спікер (маска RVM) буде ПОВЕРХ карток, тож картки можуть заходити за голову.
// Предмети перед спікером (мікрофон, чашка) у масці вважаються фоном — їх зону передаємо в `avoid`.
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const useAnim = () => {
  const f = useCurrentFrame();
  const { fps, durationInFrames: N } = useVideoConfig();
  const enter = (delay: number) => spring({ frame: f - delay, fps, config: { damping: 14, stiffness: 120, mass: 0.9 } });
  const exit = (delay = 0) => interpolate(f, [N - 12 - delay, N - delay], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });
  return { f, N, enter, exit };
};

// картка у вигляді вікна браузера; адресний рядок показує site
const Card: React.FC<{ src: string; width: number; style: React.CSSProperties }> = ({ src, width, style }) => {
  const site = React.useContext(Site);
  return <div style={{ position: 'absolute', width, borderRadius: 26, overflow: 'hidden', background: '#fff',
    boxShadow: '0 50px 90px rgba(0,0,0,.5), 0 12px 28px rgba(0,0,0,.35)', ...style }}>
    <div style={{ height: 46, background: '#eef0f6', display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px' }}>
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />)}
      {site && <div style={{ marginLeft: 14, flex: 1, height: 26, borderRadius: 13, background: '#fff', color: '#667',
        fontSize: 17, fontFamily: 'Segoe UI, Helvetica, Arial, sans-serif', display: 'flex', alignItems: 'center', paddingLeft: 14 }}>{site}</div>}
    </div>
    <Img src={staticFile('covers/' + src)} style={{ width: '100%', display: 'block' }} />
  </div>;
};

const Backdrop: React.FC<{ strength: number }> = ({ strength }) => {
  const { f, N } = useAnim();
  const o = Math.min(interpolate(f, [0, 10], [0, 1], clamp), interpolate(f, [N - 10, N], [1, 0], clamp)) * strength;
  return <AbsoluteFill style={{ opacity: o,
    background: 'radial-gradient(ellipse 80% 60% at 50% 38%, rgba(91,91,247,.35) 0%, rgba(12,14,40,.75) 55%, rgba(5,6,20,.95) 100%)' }} />;
};

// картки виринають з-за голови й розходяться віялом
const FAN = [{ x: 245, y: 560, rz: -11, ry: 20 }, { x: 835, y: 520, rz: 9, ry: -20 }, { x: 540, y: 300, rz: -2, ry: 0 }];
const Fan: React.FC<{ images: string[] }> = ({ images }) => {
  const { f, enter, exit } = useAnim();
  const list = images.slice(0, 3);
  return <>{list.map((src, i) => {
    const t = enter(i * 4) * (1 - exit((list.length - 1 - i) * 3));
    const T = FAN[i];
    const x = interpolate(t, [0, 1], [540, T.x]);
    const y = interpolate(t, [0, 1], [640, T.y]) + Math.sin(f / 18 + i * 2) * 8 * t;
    return <Card key={i} src={src} width={600} style={{ left: x, top: y, zIndex: i === 2 ? 0 : 1,
      opacity: interpolate(t, [0, 0.15], [0, 1], clamp),
      transform: `translate(-50%,-50%) perspective(1400px) rotateY(${T.ry * t}deg) rotateZ(${T.rz * t}deg) scale(${interpolate(t, [0, 1], [0.45, 1])})` }} />;
  })}</>;
};

// картки залітають з різних країв і дрейфують з різною швидкістю (паралакс), вилітають далі за курсом
const FLY = [
  { from: [-500, 380], to: [290, 400], drift: [0.5, -0.2], rz: -6, w: 600, z: 2 },
  { from: [1650, 620], to: [800, 600], drift: [-0.6, 0.15], rz: 7, w: 600, z: 1 },
  { from: [560, -420], to: [600, 210], drift: [0.25, 0.1], rz: -3, w: 500, z: 0 },
];
const Fly: React.FC<{ images: string[] }> = ({ images }) => {
  const { f, enter, exit } = useAnim();
  const list = images.slice(0, 3);
  return <>{list.map((src, i) => {
    const L = FLY[i], p = enter(i * 5), q = exit((list.length - 1 - i) * 3);
    const dx = L.to[0] - L.from[0], dy = L.to[1] - L.from[1];
    const x = L.from[0] + dx * (p + 1.6 * q) + L.drift[0] * f;
    const y = L.from[1] + dy * (p + 1.6 * q) + L.drift[1] * f;
    const ry = Math.sign(dx) * 28 * (1 - Math.min(p, 1));
    return <Card key={i} src={src} width={L.w} style={{ left: x, top: y, zIndex: L.z,
      transform: `translate(-50%,-50%) perspective(1400px) rotateY(${ry}deg) rotateZ(${L.rz}deg)` }} />;
  })}</>;
};

// стіна робіт у 3D-перспективі, повільно пливе по діагоналі
const Wall: React.FC<{ images: string[] }> = ({ images }) => {
  const { f, N, enter, exit } = useAnim();
  const cols = 3, cw = 470, gap = 34, cells = Array.from({ length: 12 }, (_, i) => images[i % images.length]);
  const q = exit();
  return <div style={{ position: 'absolute', left: 540, top: 700, width: cols * cw + (cols - 1) * gap, display: 'flex', flexWrap: 'wrap', gap,
    opacity: 1 - q,
    transform: `translate(-50%,-50%) perspective(1800px) rotateX(20deg) rotateZ(-14deg) translateY(${interpolate(f, [0, N], [140, -160])}px) scale(${1 + 0.06 * (f / N) + 0.15 * q})` }}>
    {cells.map((src, i) => {
      const d = Math.abs((i % cols) - 1) + Math.abs(Math.floor(i / cols) - 1.5);
      const p = enter(d * 3);
      return <div key={i} style={{ position: 'relative', width: cw, height: cw * 0.5625 + 46, transform: `scale(${p})`, opacity: Math.min(1, p * 2) }}>
        <Card src={src} width={cw} style={{ left: 0, top: 0 }} />
      </div>;
    })}
  </div>;
};

// весь кадр мінус прямокутник avoid (дірка через evenodd)
const clipWithout = ([x, y, w, h]: number[]) =>
  `polygon(evenodd, 0 0, 1080px 0, 1080px 1920px, 0 1920px, 0 0, ${x}px ${y}px, ${x + w}px ${y}px, ${x + w}px ${y + h}px, ${x}px ${y + h}px, ${x}px ${y}px)`;

export const Broll: React.FC<BrollProps> = ({ layout, images, w, site = '', avoid }) => (
  <Site.Provider value={site}>
    <AbsoluteFill>
      <div style={{ position: 'absolute', width: 1080, height: 1920, transform: `scale(${w / 1080})`, transformOrigin: '0 0', overflow: 'hidden' }}>
        <Backdrop strength={layout === 'wall' ? 0.8 : 0.6} />
        <AbsoluteFill style={avoid ? { clipPath: clipWithout(avoid) } : undefined}>
          {layout === 'fan' && <Fan images={images} />}
          {layout === 'fly' && <Fly images={images} />}
          {layout === 'wall' && <Wall images={images} />}
        </AbsoluteFill>
      </div>
    </AbsoluteFill>
  </Site.Provider>
);
