import React from 'react';
import { Composition } from 'remotion';
import { Broll, BrollProps } from './Broll';

const defaults: BrollProps = { layout: 'fan', images: ['example.webp'], dur: 3, w: 1080, h: 1920 };

export const Root: React.FC = () => (
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
);
