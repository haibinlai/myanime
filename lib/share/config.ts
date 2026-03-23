export const SHARE_SLOT_COUNT = 200;
export const SHARE_SLOT_COUNT_LABEL = String(SHARE_SLOT_COUNT);

export function createShareSlots<T>(): Array<T | null> {
  return Array.from({ length: SHARE_SLOT_COUNT }, () => null as T | null);
}

export function normalizeShareSlots<T>(value: unknown): Array<T | null> {
  const next = createShareSlots<T>();
  if (!Array.isArray(value)) {
    return next;
  }

  for (let index = 0; index < Math.min(value.length, SHARE_SLOT_COUNT); index += 1) {
    const item = value[index];
    next[index] = item && typeof item === "object" ? (item as T) : null;
  }

  return next;
}
