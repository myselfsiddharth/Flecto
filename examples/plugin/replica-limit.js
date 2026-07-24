export function evaluate(changes) {
  return changes
    .filter((change) => change.type === 'changed' && change.path === 'service.replicas')
    .filter((change) => typeof change.after === 'number' && change.after > 5)
    .map((change) => ({
      id: 'replica-limit',
      severity: 'warn',
      path: change.path,
      message: `Replica count is ${change.after}; expected at most 5.`,
    }));
}
