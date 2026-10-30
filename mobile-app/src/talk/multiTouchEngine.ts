import { didReachSlideToLockThreshold } from './slideToLock';

/**
 * Мультитач для кнопок «удерживай, чтобы говорить».
 *
 * React Native на Android привязывает все пальцы одного жеста к элементу, на который попал первый палец,
 * поэтому кнопки на разных карточках не могут получить свои касания по отдельности. Здесь все касания
 * принимает один корневой обработчик, а на какую кнопку попал каждый палец, определяем сами по
 * координатам. Каждый палец ведёт свою кнопку независимо: можно держать нескольких абонентов сразу.
 */
export type Rect = { x: number; y: number; w: number; h: number };

export type ZoneState = {
  rect: Rect | null;
  disabled: boolean;
  locked: boolean;
  leftHanded: boolean;
  onPress: () => void;
  onLock: () => void;
  onRelease: () => void;
};

export type TouchPoint = { id: string; x: number; y: number };

type Active = { zoneId: number; startX: number; skipRelease: boolean; lockedByGesture: boolean };

function inside(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export class MultiTouchEngine {
  private zones = new Map<number, () => ZoneState>();
  private active = new Map<string, Active>();

  register(id: number, read: () => ZoneState): () => void {
    this.zones.set(id, read);
    return () => {
      this.zones.delete(id);
    };
  }

  /** Кнопка под пальцем; при перекрытии побеждает самая маленькая. */
  hit(x: number, y: number): { id: number; zone: ZoneState } | null {
    let best: { id: number; zone: ZoneState; area: number } | null = null;
    for (const [id, read] of this.zones) {
      const zone = read();
      if (!zone.rect || !inside(zone.rect, x, y)) continue;
      const area = zone.rect.w * zone.rect.h;
      if (!best || area < best.area) best = { id, zone, area };
    }
    return best ? { id: best.id, zone: best.zone } : null;
  }

  start(points: TouchPoint[]): void {
    for (const point of points) {
      if (this.active.has(point.id)) continue;
      const found = this.hit(point.x, point.y);
      if (!found || found.zone.disabled) continue;
      // Второй палец на уже удерживаемой кнопке игнорируем, чтобы не нажать её дважды.
      if ([...this.active.values()].some((item) => item.zoneId === found.id)) continue;
      this.active.set(point.id, {
        zoneId: found.id,
        startX: point.x,
        skipRelease: found.zone.locked,
        lockedByGesture: false,
      });
      found.zone.onPress();
    }
  }

  move(points: TouchPoint[]): void {
    for (const point of points) {
      const item = this.active.get(point.id);
      if (!item || item.skipRelease || item.lockedByGesture) continue;
      const zone = this.zones.get(item.zoneId)?.();
      if (!zone || zone.disabled) continue;
      if (didReachSlideToLockThreshold(point.x, item.startX, zone.leftHanded)) {
        item.lockedByGesture = true;
        zone.onLock();
      }
    }
  }

  end(points: TouchPoint[]): void {
    for (const point of points) {
      const item = this.active.get(point.id);
      if (!item) continue;
      this.active.delete(point.id);
      if (item.skipRelease || item.lockedByGesture) continue;
      this.zones.get(item.zoneId)?.().onRelease();
    }
  }

  /** Сброс при уходе с экрана: отпускаем всё, что ещё удерживается. */
  cancelAll(): void {
    const ids = [...this.active.keys()];
    this.end(ids.map((id) => ({ id, x: 0, y: 0 })));
  }

  get activeCount(): number {
    return this.active.size;
  }
}
