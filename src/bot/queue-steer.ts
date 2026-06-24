export function queuedIdsToDeferForSteer(
  queuedIds: readonly string[],
  targetTaskId: string,
): string[] {
  if (!queuedIds.includes(targetTaskId)) return [];
  return queuedIds.filter(id => id !== targetTaskId);
}
