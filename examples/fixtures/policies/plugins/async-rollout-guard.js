import { basename } from 'node:path';

export async function evaluate(changes, ctx) {
  // Replace this with an asynchronous call to your approval service if needed.
  await Promise.resolve();

  if (
    ctx.source !== 'ci'
    || ctx.profile !== 'prod'
    || basename(ctx.file) !== 'current.json'
    || !ctx.packIds.includes('deployment-review')
  ) {
    return [];
  }

  return changes
    .filter((change) => (
      change.type === 'changed'
      && change.path === 'deployment.rollout.maxUnavailable'
      && typeof change.after === 'number'
      && change.after > 2
    ))
    .map((change) => ({
      id: 'async-rollout-approval',
      severity: 'error',
      path: change.path,
      message: `Production rollout permits ${change.after} unavailable instances; approval is required.`,
    }));
}
