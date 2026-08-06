import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelope } from '../src/envelope.js';
import { maskChangeEvent } from '../src/renderer.js';
import {
  WEBHOOK_FORMATS,
  detectWebhookFormat,
  envelopeSeverity,
  fitLines,
  formatDiscordMessage,
  formatSlackMessage,
  formatTeamsMessage,
  formatWebhookPayload,
  resolveWebhookFormat,
} from '../src/notifiers.js';

function sampleEnvelope(overrides = {}) {
  return createEnvelope({
    source: 'watch',
    file: '/srv/app/config/prod.yaml',
    changes: [
      { type: 'changed', path: 'database.pool_size', before: 5, after: 20 },
      { type: 'added', path: 'features.beta', after: true },
      { type: 'removed', path: 'legacy.flag', before: 'on' },
    ],
    ...overrides,
  });
}

function finding(severity, id = 'rule') {
  return {
    id,
    severity,
    path: 'database.pool_size',
    message: `${severity} finding`,
    pack: 'default',
  };
}

function manyChanges(count) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'changed',
    path: `services.api.env.SETTING_${i}`,
    before: `value-${i}`,
    after: `value-${i + 1}`,
  }));
}

test('flecto is the default format and returns the envelope untouched', () => {
  const envelope = sampleEnvelope();

  assert.equal(formatWebhookPayload(envelope), envelope);
  assert.equal(formatWebhookPayload(envelope, 'flecto'), envelope);
  assert.equal(JSON.stringify(formatWebhookPayload(envelope)), JSON.stringify(envelope));
});

test('formatWebhookPayload rejects unknown formats', () => {
  assert.throws(() => formatWebhookPayload(sampleEnvelope(), 'hipchat'), /Unknown webhook format/);
});

test('resolveWebhookFormat defaults to flecto and validates input', () => {
  assert.equal(resolveWebhookFormat(undefined), 'flecto');
  assert.equal(resolveWebhookFormat(''), 'flecto');
  assert.equal(resolveWebhookFormat('SLACK'), 'slack');
  assert.equal(resolveWebhookFormat(' teams '), 'teams');
  assert.throws(() => resolveWebhookFormat('hipchat'), /--webhook-format must be one of/);
  for (const format of WEBHOOK_FORMATS) {
    assert.equal(resolveWebhookFormat(format), format);
  }
});

test('resolveWebhookFormat only inspects the URL when asked for auto', () => {
  const slackUrl = 'https://hooks.slack.com/services/T000/B000/XXXX';

  assert.equal(resolveWebhookFormat(undefined, slackUrl), 'flecto');
  assert.equal(resolveWebhookFormat('auto', slackUrl), 'slack');
  assert.equal(resolveWebhookFormat('flecto', slackUrl), 'flecto');
  assert.equal(resolveWebhookFormat('discord', slackUrl), 'discord');
});

test('detectWebhookFormat maps known chat hosts', () => {
  assert.equal(detectWebhookFormat('https://hooks.slack.com/services/T000/B000/XXXX'), 'slack');
  assert.equal(detectWebhookFormat('https://discord.com/api/webhooks/123/abc'), 'discord');
  assert.equal(detectWebhookFormat('https://discordapp.com/api/webhooks/123/abc'), 'discord');
  assert.equal(detectWebhookFormat('https://acme.webhook.office.com/webhookb2/abc'), 'teams');
  assert.equal(detectWebhookFormat('https://outlook.office365.com/webhook/abc'), 'teams');
  assert.equal(detectWebhookFormat('https://hooks.example.com/notify'), 'flecto');
  assert.equal(detectWebhookFormat('https://discord.com/channels/123'), 'flecto');
  assert.equal(detectWebhookFormat('https://evil-slack.com.attacker.test/x'), 'flecto');
  assert.equal(detectWebhookFormat('not a url'), 'flecto');
  assert.equal(detectWebhookFormat(undefined), 'flecto');
});

test('envelopeSeverity reports the highest finding severity, else none', () => {
  assert.equal(envelopeSeverity(sampleEnvelope()), 'none');
  assert.equal(envelopeSeverity(sampleEnvelope({ policies: [finding('info')] })), 'info');
  assert.equal(
    envelopeSeverity(sampleEnvelope({ policies: [finding('info'), finding('warn')] })),
    'warn',
  );
  assert.equal(
    envelopeSeverity(sampleEnvelope({ policies: [finding('warn'), finding('error')] })),
    'error',
  );
});

test('slack payload is Block Kit with an mrkdwn fallback', () => {
  const envelope = sampleEnvelope({ policies: [finding('warn', 'pool-size-jump')] });
  const payload = formatSlackMessage(envelope);

  assert.equal(typeof payload.text, 'string');
  assert.match(payload.text, /Flecto — 3 changes in prod\.yaml · 1 policy finding/);
  assert.equal(payload.blocks[0].type, 'header');
  assert.equal(payload.blocks[0].text.type, 'plain_text');
  assert.match(payload.blocks[1].text.text, /\*File:\* `\/srv\/app\/config\/prod\.yaml`/);
  assert.match(payload.blocks[1].text.text, /\*Severity:\* `warn`/);

  const body = payload.blocks[2].text.text;
  assert.equal(payload.blocks[2].text.type, 'mrkdwn');
  assert.match(body, /~ database\.pool_size: 5 → 20/);
  assert.match(body, /\+ features\.beta: true/);
  assert.match(body, /- legacy\.flag: "on"/);

  assert.match(payload.blocks[3].text.text, /\*Policy findings\*/);
  assert.match(payload.blocks[3].text.text, /\[warn\] pool-size-jump \[default\]/);
  assert.equal(payload.blocks.at(-1).type, 'context');
  assert.match(payload.blocks.at(-1).elements[0].text, new RegExp(envelope.event_id));
});

test('slack severity drives the header emoji', () => {
  const emojiFor = (policies) =>
    formatSlackMessage(sampleEnvelope({ policies })).blocks[0].text.text.slice(0, 2);

  assert.equal(emojiFor([]), '🟢');
  assert.equal(emojiFor([finding('info')]), '🔵');
  assert.equal(emojiFor([finding('warn')]), '🟡');
  assert.equal(emojiFor([finding('warn'), finding('error')]), '🔴');
});

test('slack escapes mrkdwn control characters', () => {
  const payload = formatSlackMessage(sampleEnvelope({
    changes: [{ type: 'changed', path: 'cmd', before: 'a<b', after: 'x&y>z' }],
  }));

  const body = payload.blocks[2].text.text;
  assert.match(body, /a&lt;b/);
  assert.match(body, /x&amp;y&gt;z/);
  assert.doesNotMatch(body, /[<>]/);
});

test('slack keeps every section text under the 3000 char limit', () => {
  const payload = formatSlackMessage(sampleEnvelope({
    changes: manyChanges(400),
    policies: Array.from({ length: 60 }, (_, i) => finding('error', `rule-${i}`)),
  }));

  assert.ok(payload.blocks.length <= 50, 'must stay under the 50 block limit');
  assert.ok(payload.blocks[0].text.text.length <= 150, 'header limit');
  for (const block of payload.blocks) {
    if (block.type === 'section') {
      assert.ok(
        block.text.text.length <= 3_000,
        `section text was ${block.text.text.length} chars`,
      );
    }
  }
  assert.match(payload.blocks[2].text.text, /… \+\d+ more changes/);
  assert.match(payload.blocks[3].text.text, /… \+\d+ more findings/);
});

test('discord payload is an embed colored by severity', () => {
  const payload = formatDiscordMessage(sampleEnvelope({ policies: [finding('error')] }));
  const [embed] = payload.embeds;

  assert.equal(payload.embeds.length, 1);
  assert.match(embed.title, /^🔴 Flecto — /);
  assert.equal(embed.color, 0xd92d20);
  assert.match(embed.description, /~ database\.pool_size: 5 → 20/);
  assert.deepEqual(embed.fields.map((f) => f.name), ['File', 'Source', 'Severity']);
  assert.equal(embed.fields[2].value, 'error');
  assert.match(embed.footer.text, /^event /);
  assert.equal(typeof embed.timestamp, 'string');
});

test('discord severity to color mapping', () => {
  const colorFor = (policies) => formatDiscordMessage(sampleEnvelope({ policies })).embeds[0].color;

  assert.equal(colorFor([]), 0x12b76a);
  assert.equal(colorFor([finding('info')]), 0x2e90fa);
  assert.equal(colorFor([finding('warn')]), 0xf79009);
  assert.equal(colorFor([finding('info'), finding('error')]), 0xd92d20);
});

test('discord keeps the description under the 4096 char limit', () => {
  const payload = formatDiscordMessage(sampleEnvelope({
    changes: manyChanges(500),
    policies: Array.from({ length: 60 }, (_, i) => finding('warn', `rule-${i}`)),
  }));
  const [embed] = payload.embeds;

  assert.ok(embed.description.length <= 4_096, `description was ${embed.description.length} chars`);
  assert.ok(embed.title.length <= 256);
  assert.match(embed.description, /… \+\d+ more changes/);
  assert.match(embed.description, /… \+\d+ more findings/);
});

test('teams payload is a MessageCard themed by severity', () => {
  const envelope = sampleEnvelope({ policies: [finding('warn')] });
  const payload = formatTeamsMessage(envelope);

  assert.equal(payload['@type'], 'MessageCard');
  assert.equal(payload['@context'], 'https://schema.org/extensions');
  assert.equal(payload.themeColor, 'F79009');
  assert.match(payload.title, /^🟡 Flecto — /);
  assert.deepEqual(payload.sections[0].facts.map((f) => f.name), ['File', 'Source', 'Severity', 'Event']);
  assert.equal(payload.sections[0].facts[0].value, '/srv/app/config/prod.yaml');
  assert.equal(payload.sections[1].title, 'Changes');
  assert.match(payload.sections[1].text, /~ database\.pool_size: 5 → 20/);
  assert.equal(payload.sections[2].title, 'Policy findings');
});

test('teams severity to theme color mapping', () => {
  const themeFor = (policies) => formatTeamsMessage(sampleEnvelope({ policies })).themeColor;

  assert.equal(themeFor([]), '12B76A');
  assert.equal(themeFor([finding('info')]), '2E90FA');
  assert.equal(themeFor([finding('warn')]), 'F79009');
  assert.equal(themeFor([finding('error')]), 'D92D20');
});

test('teams card stays far below the 28KB message limit', () => {
  const payload = formatTeamsMessage(sampleEnvelope({
    changes: manyChanges(2_000),
    policies: Array.from({ length: 200 }, (_, i) => finding('error', `rule-${i}`)),
  }));

  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') < 28_000);
  assert.match(payload.sections[1].text, /… \+\d+ more changes/);
  assert.match(payload.sections[2].text, /… \+\d+ more findings/);
});

test('lifecycle envelopes render their lifecycle message', () => {
  const envelope = createEnvelope({
    source: 'watch',
    file: '/srv/app/.env',
    lifecycle: { type: 'unlinked', message: 'file was removed' },
  });

  assert.match(formatSlackMessage(envelope).blocks[2].text.text, /unlinked: file was removed/);
  assert.match(formatDiscordMessage(envelope).embeds[0].description, /unlinked: file was removed/);
  assert.equal(formatTeamsMessage(envelope).sections[1].title, 'Lifecycle');
  assert.match(formatTeamsMessage(envelope).sections[1].text, /unlinked: file was removed/);
});

test('empty change sets still produce a valid payload', () => {
  const envelope = sampleEnvelope({ changes: [] });

  assert.match(formatSlackMessage(envelope).text, /0 changes/);
  assert.equal(formatSlackMessage(envelope).blocks.length, 3);
  // Discord rejects empty strings in an embed, so the key is dropped entirely.
  assert.equal('description' in formatDiscordMessage(envelope).embeds[0], false);
  assert.equal(formatTeamsMessage(envelope).sections.length, 1);
});

test('values cannot break out of a code block', () => {
  const envelope = sampleEnvelope({
    changes: [{ type: 'added', path: 'note', after: '``` still inside' }],
  });

  assert.doesNotMatch(
    formatSlackMessage(envelope).blocks[2].text.text.slice(4, -4),
    /```/,
  );
  assert.doesNotMatch(
    formatDiscordMessage(envelope).embeds[0].description.slice(4, -4),
    /```/,
  );
});

test('chat payloads carry masked values when webhook masking is on', () => {
  // Mirrors index.js: outbound changes are masked before the envelope is built,
  // so every formatter sees the redacted values.
  const raw = [
    { type: 'changed', path: 'database', before: { password: 'old-pw' }, after: { password: 's3cr3t-pw' } },
    { type: 'added', path: 'auth.api_key', after: 'sk-live-abcdef' },
  ];
  const envelope = sampleEnvelope({ changes: raw.map(maskChangeEvent) });

  const payloads = [
    JSON.stringify(formatSlackMessage(envelope)),
    JSON.stringify(formatDiscordMessage(envelope)),
    JSON.stringify(formatTeamsMessage(envelope)),
  ];

  for (const payload of payloads) {
    assert.doesNotMatch(payload, /s3cr3t-pw/);
    assert.doesNotMatch(payload, /sk-live-abcdef/);
    assert.match(payload, /\*\*\*/);
  }
});

test('fitLines truncates by line count and character budget', () => {
  const lines = ['a', 'b', 'c', 'd'];

  assert.equal(fitLines([], { maxLines: 5, maxChars: 100, label: 'changes' }), '');
  assert.equal(fitLines(lines, { maxLines: 10, maxChars: 100, label: 'changes' }), 'a\nb\nc\nd');
  assert.equal(
    fitLines(lines, { maxLines: 2, maxChars: 100, label: 'changes' }),
    'a\nb\n… +2 more changes',
  );
  const wide = Array.from({ length: 4 }, () => '0123456789');
  const fitted = fitLines(wide, { maxLines: 10, maxChars: 40, label: 'changes' });
  assert.equal(fitted, '0123456789\n0123456789\n… +2 more changes');
  assert.ok(fitted.length <= 40);

  assert.equal(
    fitLines(lines, { maxLines: 10, maxChars: 100, label: 'changes', separator: '\n\n' }),
    'a\n\nb\n\nc\n\nd',
  );

  const single = fitLines(['x'.repeat(50)], { maxLines: 10, maxChars: 10, label: 'changes' });
  assert.equal(single.length, 10);
  assert.ok(single.endsWith('…'));
});
