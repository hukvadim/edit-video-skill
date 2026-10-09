import React from 'react';
import { AbsoluteFill, continueRender, delayRender, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import black from '../fonts/Montserrat-Black.ttf';
import extra from '../fonts/Montserrat-ExtraBold.ttf';

// Кінетичний текст: дрібний рядок-підводка + великий акцентний рядок, слова влітають з розмиттям (як у топових рілсах).
// Смуга 1080×560 (масштаб w/1080), ставиться в кадр центром на потрібну висоту.
export type KineticProps = { top?: string; big: string; variant: 'title' | 'callout'; accent?: string; dur: number; w: number };

const fontHandle = delayRender('fonts');
Promise.all([new FontFace('MontBlack', `url(${black})`).load(), new FontFace('MontExtra', `url(${extra})`).load()])
  .then((fs) => { fs.forEach((f) => document.fonts.add(f)); continueRender(fontHandle); });

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const Words: React.FC<{ text: string; delay: number; style: React.CSSProperties }> = ({ text, delay, style }) => {
  const f = useCurrentFrame();
  const { fps, durationInFrames: N } = useVideoConfig();
  const out = interpolate(f, [N - 9, N], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });
  return <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: '0.28em', ...style }}>
    {text.split(/\s+/).filter(Boolean).map((w, i) => {
      const p = spring({ frame: f - delay - i * 3, fps, config: { damping: 13, stiffness: 160, mass: 0.7 } });
      return <span key={i} style={{
        display: 'inline-block',
        opacity: Math.min(1, p * 1.6) * (1 - out),
        filter: `blur(${(1 - Math.min(p, 1)) * 14 + out * 10}px)`,
        transform: `translateY(${(1 - p) * 60 - out * 40}px) scale(${0.7 + 0.3 * p})`,
      }}>{w}</span>;
    })}
  </div>;
};

export const Kinetic: React.FC<KineticProps> = ({ top = '', big, variant, accent = '#FFD200', w }) => {
  const title = variant === 'title';
  const shadow = 'drop-shadow(0 8px 22px rgba(0,0,0,.55)) drop-shadow(0 2px 4px rgba(0,0,0,.6))';
  const f = useCurrentFrame();
  const { durationInFrames: N } = useVideoConfig();
  // м'яке темне світіння під текстом (не рамка): читається навіть поверх яскравого екрана
  const scrim = Math.min(interpolate(f, [0, 8], [0, 1], clamp), interpolate(f, [N - 9, N], [1, 0], clamp));
  return <AbsoluteFill>
    <div style={{ position: 'absolute', inset: 0, opacity: scrim, transform: `scale(${w / 1080})`, transformOrigin: '0 0', width: 1080, height: 560,
      background: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(8,8,16,.82) 0%, rgba(8,8,16,.6) 50%, rgba(8,8,16,0) 100%)' }} />
    <div style={{ position: 'absolute', width: 1080, height: 560, transform: `scale(${w / 1080})`, transformOrigin: '0 0',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '0 60px', boxSizing: 'border-box' }}>
      {top && <Words text={top} delay={0} style={{ fontFamily: 'MontExtra', fontSize: title ? 62 : 54, color: '#fff', filter: shadow, lineHeight: 1.1 }} />}
      <Words text={big} delay={top ? 5 : 0} style={{
        fontFamily: 'MontBlack', fontSize: title ? 100 : 92, lineHeight: 1.02, letterSpacing: '-0.01em', textAlign: 'center',
        color: title ? '#fff' : accent, filter: shadow,
      }} />
      {title && <Underline accent={accent} />}
    </div>
  </AbsoluteFill>;
};

// тонка акцентна риска під титулом, «прокреслюється» зліва направо
const Underline: React.FC<{ accent: string }> = ({ accent }) => {
  const f = useCurrentFrame();
  const { durationInFrames: N } = useVideoConfig();
  const p = interpolate(f, [8, 22], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const out = interpolate(f, [N - 9, N], [1, 0], clamp);
  return <div style={{ width: 260 * p, height: 12, borderRadius: 6, background: accent, marginTop: 18, opacity: out,
    boxShadow: '0 6px 18px rgba(0,0,0,.4)' }} />;
};
