/**
 * The pure half of the bot: what an update means, and what a reply looks like.
 *
 * No network here. An update arrives as `unknown` from the Telegram API and leaves as an
 * intent the dispatcher can act on; a draft goes in and a message with a keyboard comes
 * out. That is what makes "a second tap on Approve does not publish twice" and "a message
 * from the wrong chat is ignored silently" tests rather than hopes.
 */

import { z } from 'zod';
import {
  escape,
  bold,
  code,
  link,
  parseCommand,
  type ParsedCommand,
  type Sender,
} from '@morph/telegram';
import type { PendingDraft } from '../ports';

// -----------------------------------------------------------------------------
// Callback data
// -----------------------------------------------------------------------------

/**
 * Telegram caps `callback_data` at 64 bytes, and silently rejects the whole keyboard if
 * it is exceeded — the button simply never arrives. `approve:` plus a UUID is 44 bytes,
 * which fits with room to spare, and the test below is what stops a future action name
 * from quietly breaking every button.
 */
export const CALLBACK_DATA_LIMIT = 64;

export type QueueAction = 'approve' | 'reject';

export function encodeCallback(action: QueueAction, contentId: string): string {
  const data = `${action}:${contentId}`;

  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_LIMIT) {
    // Thrown rather than truncated: a truncated id would address a different row, or no
    // row, and the operator would tap Approve and watch nothing happen.
    throw new Error(`Callback data exceeds ${String(CALLBACK_DATA_LIMIT)} bytes: ${data}`);
  }

  return data;
}

export function decodeCallback(data: string): { action: QueueAction; contentId: string } | null {
  const match = /^(approve|reject):([0-9a-f-]{36})$/.exec(data);
  if (match === null) return null;

  return { action: match[1] as QueueAction, contentId: match[2] as string };
}

// -----------------------------------------------------------------------------
// Updates
// -----------------------------------------------------------------------------

/**
 * As much of an update as the bot uses.
 *
 * Deliberately partial: Telegram adds fields constantly, and a schema that insisted on
 * knowing all of them would start rejecting valid updates the week they ship a new one.
 * What matters is that the fields being read are the shape they claim to be.
 */
const UpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      text: z.string().optional(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      from: z.object({ id: z.union([z.number(), z.string()]) }).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      from: z.object({ id: z.union([z.number(), z.string()]) }),
      message: z
        .object({
          message_id: z.number().int(),
          chat: z.object({ id: z.union([z.number(), z.string()]) }),
        })
        .optional(),
    })
    .optional(),
});

export type Intent =
  | { readonly kind: 'command'; readonly command: ParsedCommand; readonly sender: Sender }
  | {
      readonly kind: 'callback';
      readonly action: QueueAction;
      readonly contentId: string;
      readonly sender: Sender;
      readonly callbackId: string;
      readonly messageId: number | null;
    }
  /** Nothing to do, and why — the reason is logged, never replied to. */
  | { readonly kind: 'ignore'; readonly reason: string }
  /** A message that was a command and was not understood. */
  | { readonly kind: 'unparsed'; readonly sender: Sender; readonly error: string };

export function intentOf(raw: unknown): Intent {
  const parsed = UpdateSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'ignore', reason: 'update did not match the expected shape' };

  const update = parsed.data;

  if (update.callback_query !== undefined) {
    const query = update.callback_query;
    const decoded = query.data === undefined ? null : decodeCallback(query.data);

    if (decoded === null) return { kind: 'ignore', reason: 'callback data is not a queue action' };

    return {
      kind: 'callback',
      action: decoded.action,
      contentId: decoded.contentId,
      sender: {
        // The chat is the one the keyboard was posted in. A callback with no message is a
        // very old one Telegram has forgotten the message for; treated as unauthorised
        // rather than guessed, because the chat check is the whole access control.
        chatId: String(query.message?.chat.id ?? ''),
        userId: String(query.from.id),
      },
      callbackId: query.id,
      messageId: query.message?.message_id ?? null,
    };
  }

  const message = update.message;
  if (message?.text === undefined) return { kind: 'ignore', reason: 'update carries no text' };
  if (!message.text.startsWith('/')) return { kind: 'ignore', reason: 'not a command' };

  const sender: Sender = {
    chatId: String(message.chat.id),
    // A message with no sender is a channel post. There is no user to authorise, and the
    // mutating commands are limited to named users, so it cannot be one of those.
    userId: String(message.from?.id ?? ''),
  };

  const result = parseCommand(message.text);
  return result.ok
    ? { kind: 'command', command: result.command, sender }
    : { kind: 'unparsed', sender, error: result.error };
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

export interface InlineButton {
  readonly text: string;
  readonly callback_data: string;
}

export type InlineKeyboard = readonly (readonly InlineButton[])[];

export interface QueueMessage {
  readonly text: string;
  readonly keyboard: InlineKeyboard;
}

/**
 * One draft, as a card with two buttons.
 *
 * Everything a reviewer needs to decide without opening anything: what it is about, how
 * long it is, what it draws on, and that a machine wrote it. The sources are listed in
 * full rather than counted, because "3 sources" is not something anybody can evaluate and
 * checking them is the entire job being asked of the reader.
 */
export function renderDraft(draft: PendingDraft, origin: string): QueueMessage {
  const lines = [
    bold(draft.title),
    '',
    escape(draft.summary),
    '',
    `${escape(String(draft.wordCount))} words · ${code(draft.slug)}`,
    draft.generatedBy === null
      ? escape('Written by hand.')
      : `${escape('Generated by')} ${code(draft.generatedBy)}${escape(', not yet reviewed.')}`,
    '',
    bold('Sources'),
    ...draft.sources.map(
      (source) => `· ${link(source.title, source.url)} — ${escape(source.publisher)}`,
    ),
    '',
    escape('Preview: ') + link(`${origin}/t/${draft.slug}`, `${origin}/t/${draft.slug}`),
  ];

  return {
    text: lines.join('\n'),
    keyboard: [
      [
        { text: '✓ Publish', callback_data: encodeCallback('approve', draft.id) },
        { text: '✕ Reject', callback_data: encodeCallback('reject', draft.id) },
      ],
    ],
  };
}

/**
 * What the card becomes once it has been decided.
 *
 * The keyboard is removed and the outcome is written into the message itself, so the
 * queue reads as a history rather than as a wall of identical buttons whose state lives
 * only in the operator's memory.
 */
export function renderDecided(
  draft: PendingDraft,
  action: QueueAction,
  reviewer: string,
  at: Date,
): string {
  const verdict = action === 'approve' ? 'Published' : 'Rejected';
  const stamp = at.toISOString().slice(0, 16).replace('T', ' ');

  return [
    bold(draft.title),
    '',
    escape(draft.summary),
    '',
    `${escape(verdict)} ${escape('by')} ${code(reviewer)} ${escape(`at ${stamp} UTC`)}`,
  ].join('\n');
}

/** What `/queue` says when there is nothing waiting. */
export function renderEmptyQueue(): string {
  return escape('Nothing is waiting for review.');
}

/**
 * A command the bot knows about but cannot act on yet.
 *
 * Named rather than silently ignored: a command that does nothing and says nothing is
 * indistinguishable from a bot that has crashed, and the operator's next move would be to
 * restart something that is working.
 */
export function renderNotWired(command: ParsedCommand): string {
  return escape(
    `/${command.name} is not wired yet — it needs the report pipeline. /queue and /help work.`,
  );
}
