/**
 * Handling one update from Telegram.
 *
 * The approval queue is the last gate before a machine-written page becomes a public one,
 * and the whole of MORPH's autonomy position rests on a human passing through it (§6.4,
 * D15). So this file is written the way the generate job is: it assumes the thing on the
 * other side is trying to get past it.
 *
 * THREE THINGS IT WILL NOT DO
 *
 * 1. **Reply to the wrong chat.** An unauthorised message is dropped without a word.
 *    Answering "you are not authorised" confirms that a bot exists, is live, and is
 *    listening — which is exactly what somebody probing for it is trying to learn.
 *
 * 2. **Publish twice.** Approving is idempotent at the repository: a second tap on an
 *    inline keyboard — the normal way this happens, because the button stays on screen —
 *    finds the row already decided and reports that instead of acting again.
 *
 * 3. **Publish without naming a reviewer.** The Telegram user id goes into
 *    `content.reviewed_by`, and `content_generated_needs_review` refuses the row without
 *    it. Approving anonymously is a constraint violation, not a shortcut.
 */

import { authorise, helpText, type AccessPolicy, type ParsedCommand } from '@morph/telegram';
import {
  intentOf,
  renderDecided,
  renderDraft,
  renderEmptyQueue,
  renderNotWired,
  type Intent,
  type QueueAction,
  type QueueMessage,
} from '../lib/telegram';
import type { Clock, ContentRepository, Logger } from '../ports';

/**
 * What the dispatcher wants to happen, rather than what it does.
 *
 * Returning the replies instead of sending them is what keeps this testable without a
 * network — and, more usefully, makes "what would the bot say to this" a value a test can
 * assert on rather than a mock's call log.
 */
export interface Reply {
  readonly text: string;
  readonly keyboard?: QueueMessage['keyboard'];
  /** Set when this replaces an existing message rather than adding one. */
  readonly editMessageId?: number;
}

export interface DispatchOutcome {
  readonly replies: readonly Reply[];
  /** Present for a callback: Telegram shows it as a toast and stops the button spinning. */
  readonly acknowledge?: { readonly callbackId: string; readonly text: string };
  readonly handled: boolean;
}

export interface DispatchDeps {
  readonly content: ContentRepository;
  readonly policy: AccessPolicy;
  /** For the preview link on each card. */
  readonly origin: string;
  readonly now: Clock;
  readonly log: Logger;
}

/** How many drafts one `/queue` shows. Beyond this the operator is not reviewing, scrolling. */
export const QUEUE_PAGE_SIZE = 5;

const NOTHING: DispatchOutcome = { replies: [], handled: false };

export async function dispatch(deps: DispatchDeps, raw: unknown): Promise<DispatchOutcome> {
  const intent = intentOf(raw);

  switch (intent.kind) {
    case 'ignore':
      deps.log.info('telegram.ignored', { reason: intent.reason });
      return NOTHING;

    case 'unparsed':
      return replyIfAuthorised(deps, intent.sender, intent.error);

    case 'command':
      return handleCommand(deps, intent);

    case 'callback':
      return handleCallback(deps, intent);
  }
}

async function handleCommand(
  deps: DispatchDeps,
  intent: Extract<Intent, { kind: 'command' }>,
): Promise<DispatchOutcome> {
  const decision = authorise(intent.command, intent.sender, deps.policy);

  if (!decision.allowed) {
    if (decision.silent) {
      deps.log.warn('telegram.unauthorised-chat', { chatId: intent.sender.chatId });
      return NOTHING;
    }
    return { replies: [{ text: decision.reason }], handled: true };
  }

  if (intent.command.name === 'queue') return await renderQueue(deps);

  if (intent.command.name === 'status') {
    // `/help` is not in the command table — the grammar has no entry for it — so the
    // closest thing the operator has is `/status`, and until the report pipeline exists
    // the useful answer is the command list rather than a fabricated health line.
    return { replies: [{ text: helpText() }], handled: true };
  }

  return { replies: [{ text: renderNotWired(intent.command) }], handled: true };
}

async function renderQueue(deps: DispatchDeps): Promise<DispatchOutcome> {
  const pending = await deps.content.pendingReview(QUEUE_PAGE_SIZE);

  if (pending.length === 0) {
    return { replies: [{ text: renderEmptyQueue() }], handled: true };
  }

  // One message per draft rather than one long one: each needs its own keyboard, and a
  // decision has to be able to edit the card it belongs to without touching the others.
  return {
    replies: pending.map((draft) => {
      const rendered = renderDraft(draft, deps.origin);
      return { text: rendered.text, keyboard: rendered.keyboard };
    }),
    handled: true,
  };
}

async function handleCallback(
  deps: DispatchDeps,
  intent: Extract<Intent, { kind: 'callback' }>,
): Promise<DispatchOutcome> {
  // Approving is a mutating action, so it is held to the same bar as `/promote`: the right
  // chat is not enough, it has to be a named operator. A keyboard is visible to everyone
  // in the chat, which makes this stricter check more necessary here than for a command.
  const decision = authorise({ name: 'promote', args: [] }, intent.sender, deps.policy);

  if (!decision.allowed) {
    if (decision.silent) {
      deps.log.warn('telegram.unauthorised-callback', { chatId: intent.sender.chatId });
      return NOTHING;
    }
    return {
      replies: [],
      acknowledge: { callbackId: intent.callbackId, text: 'Only the operator can decide this.' },
      handled: true,
    };
  }

  const draft = await deps.content.byId(intent.contentId);
  if (draft === null) {
    return {
      replies: [],
      acknowledge: { callbackId: intent.callbackId, text: 'That draft no longer exists.' },
      handled: true,
    };
  }

  const at = deps.now();
  const reviewer = intent.sender.userId;
  const changed = await apply(deps, intent.action, intent.contentId, reviewer, at);

  if (!changed) {
    // Already decided. The button stays on screen after a tap, so this is the ordinary
    // case rather than an error — and saying so is more useful than silence, which reads
    // as a bot that did not respond.
    deps.log.info('telegram.already-decided', { contentId: intent.contentId });
    return {
      replies: [],
      acknowledge: { callbackId: intent.callbackId, text: 'Already decided.' },
      handled: true,
    };
  }

  deps.log.info('telegram.reviewed', {
    contentId: intent.contentId,
    slug: draft.slug,
    action: intent.action,
    reviewer,
  });

  return {
    // The card is rewritten in place with the outcome and no keyboard, so the queue reads
    // as a history rather than as a wall of identical buttons.
    replies: [
      {
        text: renderDecided(draft, intent.action, reviewer, new Date(at)),
        ...(intent.messageId === null ? {} : { editMessageId: intent.messageId }),
      },
    ],
    acknowledge: {
      callbackId: intent.callbackId,
      text: intent.action === 'approve' ? 'Published.' : 'Rejected.',
    },
    handled: true,
  };
}

function apply(
  deps: DispatchDeps,
  action: QueueAction,
  contentId: string,
  reviewer: string,
  at: number,
): Promise<boolean> {
  return action === 'approve'
    ? deps.content.approve(contentId, reviewer, at)
    : deps.content.reject(contentId, reviewer, at);
}

/**
 * Reply to a malformed command, but only from the right chat.
 *
 * Same reasoning as the silent drop above: telling a stranger that their `/whatever` was
 * not understood is telling them there is something there to talk to.
 */
function replyIfAuthorised(
  deps: DispatchDeps,
  sender: { readonly chatId: string },
  text: string,
): DispatchOutcome {
  if (sender.chatId !== deps.policy.allowedChatId) {
    deps.log.warn('telegram.unauthorised-chat', { chatId: sender.chatId });
    return NOTHING;
  }
  return { replies: [{ text }], handled: true };
}

/** Re-exported so the composition root does not need to know the pure module exists. */
export type { ParsedCommand };
