import { describe, expect, it } from 'vitest';

import { MultiTouchEngine, type ZoneState } from './multiTouchEngine';

function zone(rect: ZoneState['rect'], log: string[], name: string, extra: Partial<ZoneState> = {}): () => ZoneState {
  return () => ({
    rect,
    disabled: false,
    locked: false,
    leftHanded: false,
    onPress: () => log.push(`${name}:press`),
    onLock: () => log.push(`${name}:lock`),
    onRelease: () => log.push(`${name}:release`),
    ...extra,
  });
}

describe('MultiTouchEngine', () => {
  it('holds two different buttons at the same time with two fingers', () => {
    const log: string[] = [];
    const engine = new MultiTouchEngine();
    engine.register(1, zone({ x: 0, y: 0, w: 100, h: 50 }, log, 'A'));
    engine.register(2, zone({ x: 0, y: 60, w: 100, h: 50 }, log, 'B'));
    engine.start([{ id: '0', x: 10, y: 10 }]);
    engine.start([{ id: '1', x: 10, y: 70 }]);
    expect(log).toEqual(['A:press', 'B:press']);
    engine.end([{ id: '0', x: 10, y: 10 }]);
    expect(log).toEqual(['A:press', 'B:press', 'A:release']);
    engine.end([{ id: '1', x: 10, y: 70 }]);
    expect(log.at(-1)).toBe('B:release');
    expect(engine.activeCount).toBe(0);
  });

  it('ignores a second finger on a button that is already held', () => {
    const log: string[] = [];
    const engine = new MultiTouchEngine();
    engine.register(1, zone({ x: 0, y: 0, w: 100, h: 50 }, log, 'A'));
    engine.start([{ id: '0', x: 10, y: 10 }]);
    engine.start([{ id: '1', x: 20, y: 20 }]);
    expect(log).toEqual(['A:press']);
  });

  it('does not start disabled buttons or touches outside any button', () => {
    const log: string[] = [];
    const engine = new MultiTouchEngine();
    engine.register(1, zone({ x: 0, y: 0, w: 100, h: 50 }, log, 'A', { disabled: true }));
    engine.start([{ id: '0', x: 10, y: 10 }, { id: '1', x: 500, y: 500 }]);
    expect(log).toEqual([]);
  });

  it('locks on slide and does not release afterwards; locked button unlocks on tap without release', () => {
    const log: string[] = [];
    const engine = new MultiTouchEngine();
    engine.register(1, zone({ x: 0, y: 0, w: 400, h: 50 }, log, 'A'));
    engine.start([{ id: '0', x: 300, y: 10 }]);
    engine.move([{ id: '0', x: 20, y: 10 }]);
    engine.end([{ id: '0', x: 20, y: 10 }]);
    expect(log).toEqual(['A:press', 'A:lock']);

    const log2: string[] = [];
    const e2 = new MultiTouchEngine();
    e2.register(1, zone({ x: 0, y: 0, w: 100, h: 50 }, log2, 'B', { locked: true }));
    e2.start([{ id: '0', x: 10, y: 10 }]);
    e2.end([{ id: '0', x: 10, y: 10 }]);
    expect(log2).toEqual(['B:press']);
  });

  it('prefers the smaller button when two overlap and releases everything on cancelAll', () => {
    const log: string[] = [];
    const engine = new MultiTouchEngine();
    engine.register(1, zone({ x: 0, y: 0, w: 200, h: 100 }, log, 'big'));
    engine.register(2, zone({ x: 10, y: 10, w: 30, h: 30 }, log, 'small'));
    engine.start([{ id: '0', x: 15, y: 15 }]);
    expect(log).toEqual(['small:press']);
    engine.cancelAll();
    expect(log).toEqual(['small:press', 'small:release']);
  });
});
