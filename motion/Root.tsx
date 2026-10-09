import React from 'react';
import { Composition } from 'remotion';
import { Broll, BrollProps } from './Broll';
import { Kinetic, KineticProps } from './Kinetic';

const defaults: BrollProps = { layout: 'fan', images: ['example.webp'], dur: 3, w: 1080, h: 1920 };
// top: '' обов'язково — Remotion зливає defaultProps з переданими, і без нього титул отримав би чужу підводку
const kinetic: KineticProps = { top: '', big: 'сайт, який продав', variant: 'callout', dur: 2.5, w: 1080 };

export const Root: React.FC = () => (
  <>
    <Composition
      id="Broll"
      component={Broll}
      fps={30}
      width={1080}
      height={1920}
      durationInFrames={90}
      defaultProps={defaults}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.round(props.dur * 30), width: props.w, height: props.h })}
    />
    <Composition
      id="Kinetic"
      component={Kinetic}
      fps={30}
      width={1080}
      height={560}
      durationInFrames={75}
      defaultProps={kinetic}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.round(props.dur * 30), width: props.w, height: Math.round(560 * props.w / 1080 / 2) * 2 })}
    />
  </>
);
