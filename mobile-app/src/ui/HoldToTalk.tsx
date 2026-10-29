import { useRef, type ReactNode } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';

import { didReachSlideToLockThreshold } from '../talk/slideToLock';

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
 * Работает на сырых событиях касаний (onTouch*), а не на системе responder: responder в React Native
 * отдаёт касание только одному элементу за раз, поэтому второй палец на другой кнопке игнорировался.
 * Здесь каждая кнопка следит за своим пальцем независимо, так что можно удерживать
 * несколько абонентов одновременно — говорить сразу со всеми, на кого нажали.
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
    // Нажатие на зафиксированную кнопку снимает фиксацию: отпускание после него ничего не делает.
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
    const ended = event.nativeEvent.changedTouches.some((touch) => touchId(touch) === activeTouch.current);
    if (!ended) {
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
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(locked) }}
      style={[styles.hit, disabled && styles.disabled, style]}
      onTouchStart={handleStart}
      onTouchMove={handleMove}
      onTouchEnd={handleEnd}
      onTouchCancel={handleEnd}
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
