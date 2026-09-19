import { parentPort } from 'worker_threads';

import { analyzeDocument } from './lsp-analysis.js';

// One job at a time: the server only posts the next once this one answers, and
// abandons a job by terminating the whole thread rather than asking it to stop.
parentPort?.on('message', async (job) => {
  try {
    parentPort?.postMessage({ id: job.id, diagnostics: await analyzeDocument(job) });
  } catch (err) {
    parentPort?.postMessage({ id: job.id, error: err?.message ?? String(err) });
  }
});
