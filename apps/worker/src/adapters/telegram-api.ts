/**
 * The Telegram Bot API, as much of it as the bot uses.
 *
 * Long polling rather than a webhook, and that is a decision rather than an omission: a
 * webhook needs a public HTTPS URL with a valid certificate, which needs the domain in D2.
 * Polling needs nothing, works from a laptop and from behind a NAT, and at one operator's
 * message volume the difference in latency is a second. When there is a domain, swapping
 * to a webhook changes this file and nothing above it.
 *
 * WHAT IT HANDLES THAT A NAIVE CLIENT DOES NOT
 *
 * **4096 characters.** A report is longer than that. `splitMessage` in `@morph/telegram`
 * does the splitting on section boundaries; this sends the pieces in order and stops at
 * the first failure rather than continuing and leaving a report with a hole in it.
 *
 * **429 with `retry_after`.** Telegram's rate limits are not documented as a number you
 * can compute against; they are communicated by being told to wait. Honouring
 * `retry_after` is the only reliable way to stay inside them, and ignoring it is how a
 * bot gets its token limited.
 *
 * **`ok: false` with HTTP 200.** The Bot API reports errors in the body, not the status,
 * so a client that only checks `response.ok` treats every failure as a success. That is
 * the specific bug this file exists to not have.
 */

import { z } from 'zod';
import { splitMessage } from '@morph/telegram';
import type { InlineKeyboard } from '../lib/telegram';

const ApiResponse = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
  result: z.unknown().optional(),
});

const SentMessage = z.object({ message_id: z.number().int() });

const UpdateEnvelope = z.object({ update_id: z.number().int() }).passthrough();

export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
  readonly timeoutMs?: number;
  /** How long a poll waits for an update before returning empty. Telegram caps this at 50. */
  readonly pollSeconds?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface TelegramClient {
  /** Sends a message, splitting it if needed. Returns the message ids, in order. */
  send(text: string, keyboard?: InlineKeyboard): Promise<readonly number[]>;
  edit(messageId: number, text: string): Promise<void>;
  answerCallback(callbackId: string, text: string): Promise<void>;
  /** Long-polls. Returns raw updates — parsing them is `lib/telegram.ts`'s job. */
  poll(offset: number): Promise<readonly { readonly update_id: number; readonly raw: unknown }[]>;
}

/** How many times a 429 is honoured before the call is abandoned. */
export const MAX_RATE_LIMIT_RETRIES = 3;

export function telegramClient(config: TelegramConfig): TelegramClient {
  const doFetch = config.fetch ?? globalThis.fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = config.timeoutMs ?? 15_000;
  const pollSeconds = config.pollSeconds ?? 25;

  async function call(method: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      // The poll deliberately outlives the ordinary timeout: it is *supposed* to hang for
      // `pollSeconds`, and a timeout shorter than that would abort every quiet poll.
      const budget = method === 'getUpdates' ? (pollSeconds + 10) * 1000 : timeoutMs;
      const timer = setTimeout(() => {
        controller.abort();
      }, budget);

      let parsed;
      try {
        const response = await doFetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        parsed = ApiResponse.parse(await response.json());
      } finally {
        clearTimeout(timer);
      }

      if (parsed.ok) return parsed.result;

      const retryAfter = parsed.parameters?.retry_after;
      if (retryAfter !== undefined && attempt < MAX_RATE_LIMIT_RETRIES) {
        // A second of padding: `retry_after` is when the limit lifts, and arriving at
        // exactly that instant is how a client earns a second 429.
        await sleep((retryAfter + 1) * 1000);
        continue;
      }

      throw new Error(
        `Telegram ${method} failed: ${parsed.description ?? 'no description'}${
          retryAfter === undefined
            ? ''
            : ` (rate limited, gave up after ${String(attempt + 1)} attempts)`
        }`,
      );
    }
  }

  return {
    async send(text, keyboard) {
      const chunks = splitMessage(text);
      const ids: number[] = [];

      for (const [index, chunk] of chunks.entries()) {
        const result = await call('sendMessage', {
          chat_id: config.chatId,
          text: chunk,
          parse_mode: 'MarkdownV2',
          // Previews turn a message full of source links into a wall of cards. The links
          // are there to be checked, not to be illustrated.
          link_preview_options: { is_disabled: true },
          // The keyboard belongs to the last chunk, so the buttons sit under the whole
          // message rather than in the middle of it.
          ...(keyboard !== undefined && index === chunks.length - 1
            ? { reply_markup: { inline_keyboard: keyboard } }
            : {}),
        });

        ids.push(SentMessage.parse(result).message_id);
      }

      return ids;
    },

    async edit(messageId, text) {
      await call('editMessageText', {
        chat_id: config.chatId,
        message_id: messageId,
        text,
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
        // Explicitly empty, not omitted: omitting it leaves the old keyboard in place, and
        // the whole point of editing a decided card is that its buttons go away.
        reply_markup: { inline_keyboard: [] },
      });
    },

    async answerCallback(callbackId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackId, text });
    },

    async poll(offset) {
      const result = await call('getUpdates', {
        offset,
        timeout: pollSeconds,
        // Everything else — edited messages, channel posts, reactions — is noise this bot
        // has no use for, and asking for it only makes the offset advance over updates it
        // will discard anyway.
        allowed_updates: ['message', 'callback_query'],
      });

      const updates = z.array(z.unknown()).parse(result);

      return updates.map((raw) => ({ update_id: UpdateEnvelope.parse(raw).update_id, raw }));
    },
  };
}
