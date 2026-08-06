import { highestSeverity } from './policy.js';

/**
 * Chat payload formatters.
 *
 * These are pure functions: envelope in, service-shaped JSON body out. They are
 * applied at delivery time in `alerter.js`, so the existing webhook machinery
 * (headers, timeout, retries, delivery modes, persistent queue) is reused
 * unchanged — only the serialized body differs.
 *
 * Limits coded against (service-documented maximums):
 * - Slack: 3000 chars per section `text`, 150 chars per `header` plain_text,
 *   50 blocks per message.
 * - Discord: 4096 chars per embed `description`, 256 per `title`,
 *   6000 chars across one embed.
 * - Microsoft Teams: 28 KB per incoming-webhook message.
 *
 * @typedef {'flecto' | 'slack' | 'discord' | 'teams'} WebhookFormat
 * @typedef {'error' | 'warn' | 'info' | 'none'} AlertSeverity
 */

/** Payload formats that can be selected directly. @type {WebhookFormat[]} */
export const WEBHOOK_FORMATS = ['flecto', 'slack', 'discord', 'teams'];

/** Accepted `--webhook-format` values, including URL auto-detection. */
export const WEBHOOK_FORMAT_CHOICES = [...WEBHOOK_FORMATS, 'auto'];

/**
 * Presentation per severity: emoji for text-first services, an integer color
 * for Discord embeds, and a hex string for the Teams card theme.
 */
const SEVERITY_STYLE = {
  error: { emoji: '🔴', color: 0xd92d20, themeColor: 'D92D20' },
  warn: { emoji: '🟡', color: 0xf79009, themeColor: 'F79009' },
  info: { emoji: '🔵', color: 0x2e90fa, themeColor: '2E90FA' },
  none: { emoji: '🟢', color: 0x12b76a, themeColor: '12B76A' },
};

/** Per-service budgets, kept under the documented hard limits above. */
const LIMITS = {
  slack: { title: 150, fallback: 300, body: 2_800, lines: 20 },
  discord: { title: 256, body: 3_800, lines: 20 },
  teams: { title: 256, body: 8_000, lines: 20 },
};

const VALUE_CHARS = 80;
const MESSAGE_CHARS = 200;

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Last path segment of a file path, POSIX or Windows.
 * @param {string} file
 * @returns {string}
 */
function baseName(file) {
  const parts = String(file ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : String(file ?? '');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'object') {
    try {
      return truncate(JSON.stringify(value), VALUE_CHARS);
    } catch {
      return truncate(String(value), VALUE_CHARS);
    }
  }
  return truncate(String(value), VALUE_CHARS);
}

/**
 * Highest severity across the envelope's policy findings.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {AlertSeverity}
 */
export function envelopeSeverity(envelope) {
  return highestSeverity(envelope?.policies ?? []) ?? 'none';
}

/**
 * One-line description of what happened, used in every service's title.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {string}
 */
function summarize(envelope) {
  const name = baseName(envelope?.file) || 'config';
  if (envelope?.lifecycle) {
    return `${envelope.lifecycle.type ?? 'lifecycle'} — ${name}`;
  }
  const changes = envelope?.changes?.length ?? 0;
  const findings = envelope?.policies?.length ?? 0;
  const base = `${changes} change${changes === 1 ? '' : 's'} in ${name}`;
  return findings > 0
    ? `${base} · ${findings} policy finding${findings === 1 ? '' : 's'}`
    : base;
}

/**
 * Render change events as one line each.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {string[]}
 */
export function changeLines(envelope) {
  const changes = Array.isArray(envelope?.changes) ? envelope.changes : [];
  return changes.map((change) => {
    if (change.type === 'added') return `+ ${change.path}: ${formatValue(change.after)}`;
    if (change.type === 'removed') return `- ${change.path}: ${formatValue(change.before)}`;
    const note = change.note ? ` [${change.note}]` : '';
    return `~ ${change.path}: ${formatValue(change.before)} → ${formatValue(change.after)}${note}`;
  });
}

/**
 * Render policy findings as one line each.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {string[]}
 */
export function policyLines(envelope) {
  const findings = Array.isArray(envelope?.policies) ? envelope.policies : [];
  return findings.map((finding) => {
    const pack = finding.pack ? ` [${finding.pack}]` : '';
    return `[${finding.severity}] ${finding.id}${pack} ${finding.path}: ${truncate(finding.message ?? '', MESSAGE_CHARS)}`;
  });
}

/**
 * Join lines within a line count and character budget, appending a "+N more"
 * marker instead of posting a wall of text.
 * @param {string[]} lines
 * @param {{ maxLines: number, maxChars: number, label: string, separator?: string }} limits
 * @returns {string}
 */
export function fitLines(lines, limits) {
  if (!lines || lines.length === 0) return '';
  const separator = limits.separator ?? '\n';
  let kept = lines.slice(0, limits.maxLines);
  const render = () => {
    const omitted = lines.length - kept.length;
    const body = kept.join(separator);
    return omitted > 0 ? `${body}${separator}… +${omitted} more ${limits.label}` : body;
  };

  let text = render();
  while (text.length > limits.maxChars && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = render();
  }
  return truncate(text, limits.maxChars);
}

/**
 * Body lines for an envelope: change lines, or the lifecycle message when the
 * envelope carries no changes.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {string[]}
 */
function bodyLines(envelope) {
  if (envelope?.lifecycle) {
    return [`${envelope.lifecycle.type ?? 'lifecycle'}: ${envelope.lifecycle.message ?? ''}`.trim()];
  }
  return changeLines(envelope);
}

/**
 * Neutralize fence sequences so a value can never break out of a code block.
 * @param {string} text
 * @returns {string}
 */
function sanitizeFence(text) {
  return text.replaceAll('```', "'''");
}

/**
 * Escape the characters Slack reserves in mrkdwn text.
 * @param {string} text
 * @returns {string}
 */
function escapeSlack(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Format an envelope as a Slack Block Kit message. `text` carries the same
 * summary as a notification fallback for clients that do not render blocks.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {Record<string, unknown>}
 */
export function formatSlackMessage(envelope) {
  const severity = envelopeSeverity(envelope);
  const style = SEVERITY_STYLE[severity];
  const summary = summarize(envelope);
  const title = `${style.emoji} Flecto — ${summary}`;
  const limits = LIMITS.slack;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncate(title, limits.title), emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*File:* \`${escapeSlack(envelope?.file ?? '')}\``,
          `*Source:* \`${escapeSlack(envelope?.source ?? '')}\` · *Severity:* \`${severity}\``,
        ].join('\n'),
      },
    },
  ];

  const changes = fitLines(bodyLines(envelope).map((line) => escapeSlack(line)), {
    maxLines: limits.lines,
    maxChars: limits.body,
    label: 'changes',
  });
  if (changes) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${sanitizeFence(changes)}\n\`\`\`` },
    });
  }

  const findings = fitLines(policyLines(envelope).map((line) => escapeSlack(line)), {
    maxLines: limits.lines,
    maxChars: limits.body,
    label: 'findings',
  });
  if (findings) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Policy findings*\n\`\`\`\n${sanitizeFence(findings)}\n\`\`\`` },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `event \`${escapeSlack(envelope?.event_id ?? '')}\` · ${escapeSlack(envelope?.emitted_at ?? '')}`,
    }],
  });

  return { text: truncate(escapeSlack(title), limits.fallback), blocks };
}

/**
 * Format an envelope as a Discord webhook message with one embed, colored by
 * the highest policy severity.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {Record<string, unknown>}
 */
export function formatDiscordMessage(envelope) {
  const severity = envelopeSeverity(envelope);
  const style = SEVERITY_STYLE[severity];
  const summary = summarize(envelope);
  const limits = LIMITS.discord;

  const sections = [];
  const changes = fitLines(bodyLines(envelope), {
    maxLines: limits.lines,
    maxChars: Math.floor(limits.body * 0.65),
    label: 'changes',
  });
  if (changes) sections.push(`\`\`\`\n${sanitizeFence(changes)}\n\`\`\``);

  const findings = fitLines(policyLines(envelope), {
    maxLines: limits.lines,
    maxChars: Math.floor(limits.body * 0.3),
    label: 'findings',
  });
  if (findings) sections.push(`**Policy findings**\n\`\`\`\n${sanitizeFence(findings)}\n\`\`\``);

  /** @type {Record<string, unknown>} */
  const embed = {
    title: truncate(`${style.emoji} Flecto — ${summary}`, limits.title),
    color: style.color,
    fields: [
      { name: 'File', value: truncate(`\`${envelope?.file ?? ''}\``, 1_024), inline: false },
      { name: 'Source', value: String(envelope?.source ?? 'watch'), inline: true },
      { name: 'Severity', value: severity, inline: true },
    ],
    footer: { text: truncate(`event ${envelope?.event_id ?? ''}`, 2_048) },
  };
  const description = truncate(sections.join('\n'), limits.body);
  if (description) embed.description = description;
  if (envelope?.emitted_at) embed.timestamp = envelope.emitted_at;

  return { embeds: [embed] };
}

/**
 * Format an envelope as a Microsoft Teams MessageCard (the shape Office 365
 * connector webhooks accept). Card text uses blank-line separators because
 * MessageCard markdown collapses single newlines.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @returns {Record<string, unknown>}
 */
export function formatTeamsMessage(envelope) {
  const severity = envelopeSeverity(envelope);
  const style = SEVERITY_STYLE[severity];
  const summary = summarize(envelope);
  const limits = LIMITS.teams;

  const sections = [{
    facts: [
      { name: 'File', value: String(envelope?.file ?? '') },
      { name: 'Source', value: String(envelope?.source ?? 'watch') },
      { name: 'Severity', value: severity },
      { name: 'Event', value: String(envelope?.event_id ?? '') },
    ],
    markdown: true,
  }];

  const changes = fitLines(bodyLines(envelope), {
    maxLines: limits.lines,
    maxChars: limits.body,
    label: 'changes',
    separator: '\n\n',
  });
  if (changes) {
    sections.push({
      title: envelope?.lifecycle ? 'Lifecycle' : 'Changes',
      text: changes,
      markdown: true,
    });
  }

  const findings = fitLines(policyLines(envelope), {
    maxLines: limits.lines,
    maxChars: limits.body,
    label: 'findings',
    separator: '\n\n',
  });
  if (findings) sections.push({ title: 'Policy findings', text: findings, markdown: true });

  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: truncate(`Flecto — ${summary}`, limits.title),
    themeColor: style.themeColor,
    title: truncate(`${style.emoji} Flecto — ${summary}`, limits.title),
    sections,
  };
}

/**
 * Guess a payload format from the webhook host. Only used when the format is
 * explicitly requested as `auto` — the default stays `flecto` so existing
 * webhook receivers keep getting the raw envelope.
 * @param {string | undefined} url
 * @returns {WebhookFormat}
 */
export function detectWebhookFormat(url) {
  if (!url) return 'flecto';
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return 'flecto';
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const hostIs = (domain) => host === domain || host.endsWith(`.${domain}`);

  if (hostIs('slack.com')) return 'slack';
  if ((hostIs('discord.com') || hostIs('discordapp.com')) && path.includes('/api/webhooks')) {
    return 'discord';
  }
  if (hostIs('office.com') || hostIs('office365.com')) return 'teams';
  return 'flecto';
}

/**
 * Normalize a requested webhook format. Unset means `flecto`; `auto` inspects
 * the webhook URL.
 * @param {unknown} requested
 * @param {string} [url]
 * @returns {WebhookFormat}
 */
export function resolveWebhookFormat(requested, url) {
  if (requested === undefined || requested === null || requested === '') return 'flecto';
  const value = String(requested).trim().toLowerCase();
  if (value === 'auto') return detectWebhookFormat(url);
  if (!WEBHOOK_FORMATS.includes(/** @type {WebhookFormat} */ (value))) {
    throw new Error(`--webhook-format must be one of: ${WEBHOOK_FORMAT_CHOICES.join(', ')}`);
  }
  return /** @type {WebhookFormat} */ (value);
}

/**
 * Shape an envelope for the target service. `flecto` returns the envelope
 * itself — the exact object that has always been posted — so the default
 * delivery path is byte-for-byte unchanged.
 * @param {import('./envelope.js').FlectoEnvelope} envelope
 * @param {WebhookFormat} [format]
 * @returns {unknown}
 */
export function formatWebhookPayload(envelope, format = 'flecto') {
  switch (format) {
    case 'slack':
      return formatSlackMessage(envelope);
    case 'discord':
      return formatDiscordMessage(envelope);
    case 'teams':
      return formatTeamsMessage(envelope);
    case 'flecto':
      return envelope;
    default:
      throw new Error(`Unknown webhook format: ${format}`);
  }
}
