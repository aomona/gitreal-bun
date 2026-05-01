// challenge.ts – grace seconds logic (mirrors internal/challenge/grace.go)

export const DefaultGraceSeconds = 120;
export const MinGraceSeconds = 1;
export const MaxGraceSeconds = 3600;

export function normalizeGraceSeconds(value: number): number {
  if (value < MinGraceSeconds) return MinGraceSeconds;
  if (value > MaxGraceSeconds) return MaxGraceSeconds;
  return value;
}
