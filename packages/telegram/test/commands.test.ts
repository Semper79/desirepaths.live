import { describe, expect, it } from 'vitest';
import {
  authorise,
  COMMANDS,
  helpText,
  MUTATING_COMMANDS,
  parseCommand,
  type AccessPolicy,
} from '../src/commands';

const POLICY: AccessPolicy = { allowedChatId: '-100123', adminUserIds: ['777'] };

describe('parseCommand', () => {
  it('parses a bare command', () => {
    const result = parseCommand('/status');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.name).toBe('status');
      expect(result.command.args).toEqual([]);
    }
  });

  it('accepts the @BotName form Telegram produces in groups', () => {
    const result = parseCommand('/status@MorphOpsBot');
    expect(result.ok).toBe(true);
  });

  it('tolerates surrounding and repeated whitespace', () => {
    const result = parseCommand('  /promote   hero.headline    hero.headline#v0  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.command.args).toEqual(['hero.headline', 'hero.headline#v0']);
  });

  it('stays quiet about text that is not a command at all', () => {
    const result = parseCommand('good morning');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not-a-command');
  });

  it('rejects an unknown command', () => {
    const result = parseCommand('/deploy');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unknown command');
  });

  it('enforces the argument shape of every command', () => {
    const cases: readonly [string, boolean][] = [
      ['/promote hero.headline hero.headline#v0', true],
      ['/promote hero.headline', false],
      ['/pin theme.palette theme.palette#dark-neon', true],
      ['/pin theme.palette', false],
      ['/rollback hero.media', true],
      ['/rollback', false],
      ['/autonomy review', true],
      ['/autonomy yolo', false],
      ['/autonomy', false],
      ['/quiet 6', true],
      ['/quiet 0', false],
      ['/quiet 48', false],
      ['/quiet soon', false],
      ['/status', true],
      ['/status now', false],
      ['/kill', true],
      ['/queue', true],
      ['/trends', true],
      ['/report', true],
      ['/surfaces', true],
      ['/resume', true],
      ['/pause_adaptation', true],
    ];

    for (const [text, expected] of cases) {
      expect(parseCommand(text).ok, text).toBe(expected);
    }
  });
});

describe('authorise', () => {
  const cmd = (text: string) => {
    const parsed = parseCommand(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.command;
  };

  it('ignores the wrong chat silently, so probing reveals nothing', () => {
    const result = authorise(cmd('/status'), { chatId: '-999', userId: '777' }, POLICY);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.silent).toBe(true);
  });

  it('allows read-only commands from any user in the right chat', () => {
    expect(authorise(cmd('/status'), { chatId: '-100123', userId: '42' }, POLICY).allowed).toBe(
      true,
    );
    expect(authorise(cmd('/surfaces'), { chatId: '-100123', userId: '42' }, POLICY).allowed).toBe(
      true,
    );
  });

  it('restricts every mutating command to an admin', () => {
    for (const name of MUTATING_COMMANDS) {
      const text =
        name === 'promote' || name === 'pin'
          ? `/${name} a.b a.b#c`
          : name === 'rollback'
            ? `/${name} a.b`
            : name === 'autonomy'
              ? `/${name} review`
              : name === 'quiet'
                ? `/${name} 3`
                : `/${name}`;

      const stranger = authorise(cmd(text), { chatId: '-100123', userId: '42' }, POLICY);
      expect(stranger.allowed, name).toBe(false);
      if (!stranger.allowed) expect(stranger.silent).toBe(false);

      expect(authorise(cmd(text), { chatId: '-100123', userId: '777' }, POLICY).allowed, name).toBe(
        true,
      );
    }
  });

  it('treats /kill as mutating - it freezes the entire autonomous system', () => {
    expect(MUTATING_COMMANDS.has('kill')).toBe(true);
  });
});

describe('helpText', () => {
  it('lists every command, so it cannot drift out of date', () => {
    const text = helpText();
    for (const c of COMMANDS) expect(text).toContain(`/${c}`);
  });

  it('marks the commands that change behaviour', () => {
    const lines = helpText().split('\n');
    for (const line of lines) {
      const name = line.slice(1).split(/[\s*]/)[0] ?? '';
      const marked = line.includes(' *');
      expect(marked, name).toBe(MUTATING_COMMANDS.has(name as never));
    }
  });
});
