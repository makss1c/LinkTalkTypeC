import { useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';

import { didReachSlideToLockThreshold } from '../talk/slideToLock';
import type { Rect } from '../talk/multiTouchEngine';
import { MultiTouchContext } from './MultiTouch';

type Props = {
  accessibilityLabel: string;
  disabled?: boolean;
  locked?: boolean;
  leftHanded?: boolean;
  style?: StyleProp<ViewStyle>;
  onPress: () => void;
  onLock: () => void;
  onRelease: () => void;
  children: ReactNode;
};

/**
 * Кнопка «удерживай, чтобы говорить».
 *
 * Внутри MultiTouchRoot (экран пульта) касания принимает корень и раздаёт кнопкам по координатам —
 * так можно удерживать несколько абонентов разными пальцами одновременно.
 * Вне корня (например, на экране рации) кнопка сама следит за одним пальцем.
 */
export function HoldToTalk({
  accessibilityLabel,
  disabled,
  locked,
  leftHanded = false,
  style,
  onPress,
  onLock,
  onRelease,
  children,
}: Props) {
  const multi = useContext(MultiTouchContext);
  const ref = useRef<View>(null);
  const rect = useRef<Rect | null>(null);
  const zoneId = useRef(0);

  // Актуальные свойства для обработчика корня (он читает их в момент касания).
  const latest = useRef({ disabled: false, locked: false, leftHanded: false, onPress, onLock, onRelease });
  latest.current = { disabled: Boolean(disabled), locked: Boolean(locked), leftHanded, onPress, onLock, onRelease };

  const measure = useCallback(() => {
    ref.current?.measure((_x, _y, width, height, pageX, pageY) => {
      if (width > 0 && height > 0) {
        rect.current = { x: pageX, y: pageY, w: width, h: height };
      }
    });
  }, []);

  useEffect(() => {
    if (!multi) {
      return undefined;
    }
    if (!zoneId.current) {
      zoneId.current = multi.nextId();
    }
    const unregister = multi.engine.register(zoneId.current, () => ({ rect: rect.current, ...latest.current }));
    const unmeasure = multi.addMeasurer(measure);
    measure();
    return () => {
      unregister();
      unmeasure();
    };
  }, [multi, measure]);

  // --- запасной режим: один палец, без корня мультитача ---
  const activeTouch = useRef<string | null>(null);
  const startX = useRef(0);
  const lockedByGesture = useRef(false);
  const skipRelease = useRef(false);
  const touchId = (touch: { identifier?: unknown }): string => String(touch.identifier ?? '0');

  const handleStart = (event: GestureResponderEvent) => {
    if (disabled || activeTouch.current !== null) {
      return;
    }
    const touch = event.nativeEvent.changedTouches[0];
    if (!touch) {
      return;
    }
    activeTouch.current = touchId(touch);
    startX.current = touch.pageX;
    lockedByGesture.current = false;
    skipRelease.current = Boolean(locked);
    onPress();
  };
  const handleMove = (event: GestureResponderEvent) => {
    if (disabled || activeTouch.current === null || skipRelease.current || lockedByGesture.current) {
      return;
    }
    const mine = event.nativeEvent.touches.find((touch) => touchId(touch) === activeTouch.current);
    if (mine && didReachSlideToLockThreshold(mine.pageX, startX.current, leftHanded)) {
      lockedByGesture.current = true;
      onLock();
    }
  };
  const handleEnd = (event: GestureResponderEvent) => {
    if (activeTouch.current === null) {
      return;
    }
    if (!event.nativeEvent.changedTouches.some((touch) => touchId(touch) === activeTouch.current)) {
      return;
    }
    activeTouch.current = null;
    if (skipRelease.current || lockedByGesture.current) {
      return;
    }
    onRelease();
  };

  return (
    <View
      ref={ref}
      collapsable={false}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(locked) }}
      style={[styles.hit, disabled && styles.disabled, style]}
      onLayout={multi ? measure : undefined}
      onTouchStart={multi ? undefined : handleStart}
      onTouchMove={multi ? undefined : handleMove}
      onTouchEnd={multi ? undefined : handleEnd}
      onTouchCancel={multi ? undefined : handleEnd}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  hit: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.45,
  },
});
