export const formatTime = (totalSeconds: number): string => {
  // Math.max(0, NaN) is NaN, and every padStart below then renders it — the
  // clock read "NaN:NaN". Infinity floors to Infinity for the same reason.
  if (!Number.isFinite(totalSeconds)) return '00:00';
  const safeSeconds = Math.floor(Math.max(0, totalSeconds));
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = safeSeconds % 60;

  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};
