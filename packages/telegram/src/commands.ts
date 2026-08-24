/**
 * The operator command surface (section 5, "Interactive bot commands").
 *
 * Parsing and authorisation only - executing a command is the worker's job. Keeping
 * this pure means the authorisation rules can be tested exhaustively without a bot
 * token, a chat, or a network.
 *
 * THE ACCESS MODEL
 * The bot answers exactly one chat id, and mutating commands additionally require
 * the sender to be on the admin list. That is a deliberately small model: this bot
 * can freeze the entire autonomous system, so the correct number of people able to
 * reach it is "the operator", not "whoever finds the bot".
 */

export const COMMANDS = [
  'status',
  'surfaces',
  'promote',
  'pin',
  'rollback',
  'pause_adaptation',
  'resume',
  'queue',
  'autonomy',
  'kill',
  'report',
  'trends',
  'quiet',
] as const;

export type CommandName = (typeof COMMANDS)[number];

/**
 * Commands that change what the system does. These require an admin sender, not
 * merely the right chat.
 */
export const MUTATING_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'promote',
  'pin',
  'rollback',
  'pause_adaptation',
  'resume',
  'autonomy',
  'kill',
  'quiet',
]);

export interface ParsedCommand {
  readonly name: CommandName;
  readonly args: readonly string[];
}

export type ParseResult =
  | { readonly ok: true; readonly command: ParsedCommand }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a message into a command.
 *
 * Accepts the `/cmd@BotName` form Telegram produces in groups, and normalises
 * whitespace. Anything that is not a slash command is not an error - it is simply
 * not a command, and the bot stays quiet rather than lecturing the operator.
 */
export function parseCommand(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { ok: false, error: 'not-a-command' };

  const [head = '', ...args] = trimmed.slice(1).split(/\s+/);
  const name = (head.split('@')[0] ?? '').toLowerCase();

  if (!(COMMANDS as readonly string[]).includes(name)) {
    return { ok: false, error: `Unknown command: /${name}` };
  }

  const command: ParsedCommand = { name: name as CommandName, args };
  const validation = validateArgs(command);
  return validation === null ? { ok: true, command } : { ok: false, error: validation };
}

const AUTONOMY_LEVELS = new Set(['manual', 'review', 'auto']);

function validateArgs(command: ParsedCommand): string | null {
  switch (command.name) {
    case 'promote':
    case 'pin':
      return command.args.length === 2
        ? null
        : `Usage: /${command.name} <surface> <variant>`;
    case 'rollback':
      return command.args.length === 1 ? null : 'Usage: /rollback <surface>';
    case 'autonomy':
      return command.args.length === 1 && AUTONOMY_LEVELS.has(command.args[0] ?? '')
        ? null
        : 'Usage: /autonomy <manual|review|auto>';
    case 'quiet': {
      const hours = Number.parseInt(command.args[0] ?? '', 10);
      return Number.isInteger(hours) && hours > 0 && hours <= 24
        ? null
        : 'Usage: /quiet <hours>  (1-24)';
    }
    case 'status':
    case 'surfaces':
    case 'pause_adaptation':
    case 'resume':
    case 'queue':
    case 'kill':
    case 'report':
    case 'trends':
      return command.args.length === 0 ? null : `/${command.name} takes no arguments`;
  }
}

export interface Sender {
  readonly chatId: string;
  readonly userId: string;
}

export interface AccessPolicy {
  readonly allowedChatId: string;
  readonly adminUserIds: readonly string[];
}

export type AuthorisationResult =
  | { readonly allowed: true }
  /** `silent` means: do not reply at all. */
  | { readonly allowed: false; readonly silent: true }
  | { readonly allowed: false; readonly silent: false; readonly reason: string };

/**
 * Decide whether a sender may run a command.
 *
 * A message from the wrong chat is ignored *silently*. Replying "you are not
 * authorised" confirms the bot exists and is live, which is exactly the information
 * someone probing for it wants.
 */
export function authorise(
  command: ParsedCommand,
  sender: Sender,
  policy: AccessPolicy,
): AuthorisationResult {
  if (sender.chatId !== policy.allowedChatId) return { allowed: false, silent: true };

  if (MUTATING_COMMANDS.has(command.name) && !policy.adminUserIds.includes(sender.userId)) {
    return {
      allowed: false,
      silent: false,
      reason: `/${command.name} changes system behaviour and is limited to the operator.`,
    };
  }

  return { allowed: true };
}

/** `/help` text, generated from the command table so it cannot drift out of date. */
export function helpText(): string {
  const describe: Record<CommandName, string> = {
    status: 'health, traffic and the live theme right now',
    surfaces: 'every surface, its champion and its active variants',
    promote: 'make a variant the champion of a surface',
    pin: 'force a variant and suspend learning on that surface',
    rollback: 'revert a surface to its baseline',
    pause_adaptation: 'freeze assignment on current champions',
    resume: 'resume adaptation',
    queue: 'review pending outbound posts',
    autonomy: 'set the outbound autonomy level',
    kill: 'emergency freeze of all autonomous behaviour',
    report: 'send the hourly report now',
    trends: 'current trend clusters and their scores',
    quiet: 'suppress non-critical reports for N hours',
  };

  return COMMANDS.map((c) => {
    const marker = MUTATING_COMMANDS.has(c) ? ' *' : '';
    return `/${c}${marker} — ${describe[c]}`;
  }).join('\n');
}
