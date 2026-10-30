import { createContext, useEffect, useMemo, type ReactNode } from 'react';
import { View, type GestureResponderEvent, type NativeTouchEvent, type StyleProp, type ViewStyle } from 'react-native';

import { MultiTouchEngine, type TouchPoint } from '../talk/multiTouchEngine';

export type MultiTouchContextValue = {
  engine: MultiTouchEngine;
  nextId: () => number;
  addMeasurer: (measure: () => void) => () => void;
  remeasure: () => void;
};

/** Есть только внутри MultiTouchRoot. Кнопки вне корня работают одним пальцем сами по себе. */
export const MultiTouchContext = createContext<MultiTouchContextValue | null>(null);

function toPoints(list: readonly NativeTouchEvent[]): TouchPoint[] {
  return list.map((touch) => ({ id: String(touch.identifier), x: touch.pageX, y: touch.pageY }));
}

/**
 * Корень мультитача. Принимает касания всех пальцев и раздаёт их кнопкам HoldToTalk внутри себя,
 * определяя нужную кнопку по координатам (см. talk/multiTouchEngine.ts).
 */
export function MultiTouchRoot({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const value = useMemo<MultiTouchContextValue>(() => {
    const engine = new MultiTouchEngine();
    const measurers = new Set<() => void>();
    let sequence = 0;
    return {
      engine,
      nextId: () => ++sequence,
      addMeasurer: (measure) => {
        measurers.add(measure);
        return () => {
          measurers.delete(measure);
        };
      },
      remeasure: () => measurers.forEach((measure) => measure()),
    };
  }, []);

  // При уходе с экрана отпускаем всё, что ещё удерживается.
  useEffect(() => () => value.engine.cancelAll(), [value]);

  const onStart = (event: GestureResponderEvent) => {
    value.engine.start(toPoints(event.nativeEvent.changedTouches));
    // Свежие координаты кнопок к моменту, когда придёт второй палец.
    value.remeasure();
  };
  const onMove = (event: GestureResponderEvent) => value.engine.move(toPoints(event.nativeEvent.touches));
  const onEnd = (event: GestureResponderEvent) => {
    value.engine.end(toPoints(event.nativeEvent.changedTouches));
    value.remeasure();
  };

  return (
    <MultiTouchContext.Provider value={value}>
      <View
        collapsable={false}
        style={[{ flex: 1 }, style]}
        onLayout={value.remeasure}
        onTouchStart={onStart}
        onTouchMove={onMove}
        onTouchEnd={onEnd}
        onTouchCancel={onEnd}
      >
        {children}
      </View>
    </MultiTouchContext.Provider>
  );
}
