/** LinkTalk: «подслушка» — постоянная прослушка выбранного абонента (выдаётся администратором). */
export type MonitorLink = {
  targetUserId: number;
  name: string;
  /** Принудительная: включена администратором, пользователь выключить не может. */
  forced: boolean;
  enabled: boolean;
};

export function parseMonitors(payload: unknown): MonitorLink[] {
  const record = payload && typeof payload === 'object' ? (payload as { monitors?: unknown }) : {};
  if (!Array.isArray(record.monitors)) {
    return [];
  }
  const result: MonitorLink[] = [];
  for (const item of record.monitors) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const value = item as Record<string, unknown>;
    const id = Number(value.targetUserId);
    if (!Number.isInteger(id) || id < 1) {
      continue;
    }
    result.push({
      targetUserId: id,
      name: typeof value.name === 'string' && value.name ? value.name : `#${id}`,
      forced: value.forced === true,
      enabled: value.forced === true || value.enabled === true,
    });
  }
  return result;
}
