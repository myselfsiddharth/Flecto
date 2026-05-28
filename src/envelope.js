import { randomUUID } from 'crypto';

export const EVENT_SCHEMA_VERSION = '1.1';

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
 *  lifecycle?: { type: string, message: string }
 * }} SentinelEnvelope
 */

/**
 * Create a stable event envelope for automation sinks.
 * @param {{
 *  file: string,
 *  source: EventSource,
 *  changes?: import('./differ.js').ChangeEvent[],
 *  lifecycle?: { type: string, message: string },
 *  batchId?: string
 * }} input
 * @returns {SentinelEnvelope}
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
    lifecycle: input.lifecycle,
  };
}

