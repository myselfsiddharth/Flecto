import { randomUUID } from 'crypto';
import { CLASSIFIER_MODEL_VERSION, secretClassifierEnabled } from './classify.js';

export const EVENT_SCHEMA_VERSION = '2.0';

/**
 * @typedef {'watch' | 'ci' | 'diff'} EventSource
 * @typedef {'changes' | 'lifecycle'} EnvelopeEventType
 *
 * @typedef {{
 *  schema_version: string,
 *  event_id: string,
 *  batch_id: string,
 *  event_type: EnvelopeEventType,
 *  source: EventSource,
 *  emitted_at: string,
 *  file: string,
 *  changes: import('./differ.js').ChangeEvent[],
 *  policies?: import('./policy.js').PolicyFinding[],
 *  lifecycle?: { type: string, message: string },
 *  classifier_version?: string
 * }} FlectoEnvelope
 */

/**
 * Create a stable event envelope for automation sinks.
 * @param {{
 *  file: string,
 *  source: EventSource,
 *  changes?: import('./differ.js').ChangeEvent[],
 *  policies?: import('./policy.js').PolicyFinding[],
 *  lifecycle?: { type: string, message: string },
 *  batchId?: string
 * }} input
 * @returns {FlectoEnvelope}
 */
export function createEnvelope(input) {
  const batchId = input.batchId ?? randomUUID();
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: randomUUID(),
    batch_id: batchId,
    event_type: input.lifecycle ? 'lifecycle' : 'changes',
    source: input.source,
    emitted_at: new Date().toISOString(),
    file: input.file,
    changes: input.changes ?? [],
    policies: input.policies ?? [],
    lifecycle: input.lifecycle,
    // Present only when the classifier ran. Changing the model changes which
    // values are masked, so a consumer must be able to tell which model
    // produced a given event -- the same reason schema_version is here.
    ...(secretClassifierEnabled() ? { classifier_version: CLASSIFIER_MODEL_VERSION } : {}),
  };
}
