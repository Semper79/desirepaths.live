import { describe, expect, it } from 'vitest';
import { dispatch, QUEUE_PAGE_SIZE } from '../src/jobs/dispatch';
import {
  CALLBACK_DATA_LIMIT,
  decodeCallback,
  encodeCallback,
  intentOf,
  renderDecided,
  renderDraft,
} from '../src/lib/telegram';
import { telegramClient, MAX_RATE_LIMIT_RETRIES } from '../src/adapters/telegram-api';
import { promptFor } from '../src/adapters/anthropic-prose';
import { SAMPLE_REPORT_INPUT } from '@morph/telegram';
import { FakeContent, FakeLogger } from './fakes';

const NOW = 1_700_000_000_000;
const CHAT = '-1001234567890';
const ADMIN = '55501';
const STRANGER = '99999';
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function harness() {
  const content = new FakeContent();
  const log = new FakeLogger();

  return {
    content,
    log,
    deps: {
      content,
      policy: { allowedChatId: CHAT, adminUserIds: [ADMIN] },
      origin: 'https://morph.example',
      now: () => NOW,
      log,
    },
  };
}

const command = (text: string, from = ADMIN, chat = CHAT): unknown => ({
  update_id: 1,
  message: { text, chat: { id: chat }, from: { id: from } },
});

const callback = (data: string, from = ADMIN, chat = CHAT): unknown => ({
  update_id: 2,
  callback_query: {
    id: 'cb-1',
    data,
    from: { id: from },
    message: { message_id: 42, chat: { id: chat } },
  },
});

// -----------------------------------------------------------------------------

describe('callback data', () => {
  it('round-trips an action and an id', () => {
    expect(decodeCallback(encodeCallback('approve', ID))).toEqual({
      action: 'approve',
      contentId: ID,
    });
    expect(decodeCallback(encodeCallback('reject', ID))).toEqual({
      action: 'reject',
      contentId: ID,
    });
  });

  /**
   * Telegram silently rejects a keyboard whose callback data exceeds 64 bytes — the button
   * never arrives, and nothing says why. This is the test that stops a future action name
   * from quietly breaking every button in the queue.
   */
  it('fits inside the 64-byte limit with room to spare', () => {
    for (const action of ['approve', 'reject'] as const) {
      expect(Buffer.byteLength(encodeCallback(action, ID))).toBeLessThanOrEqual(
        CALLBACK_DATA_LIMIT,
      );
    }
  });

  it('throws rather than truncating an id that would not fit', () => {
    expect(() => encodeCallback('approve', 'x'.repeat(70))).toThrow(/exceeds/);
  });

  it('refuses anything it did not encode', () => {
    expect(decodeCallback('approve:not-a-uuid')).toBeNull();
    expect(decodeCallback('delete:' + ID)).toBeNull();
    expect(decodeCallback('')).toBeNull();
  });
});

describe('reading an update', () => {
  it('recognises a command', () => {
    const intent = intentOf(command('/queue'));
    expect(intent.kind).toBe('command');
    if (intent.kind === 'command') {
      expect(intent.command.name).toBe('queue');
      expect(intent.sender).toEqual({ chatId: CHAT, userId: ADMIN });
    }
  });

  it('recognises a queue decision', () => {
    const intent = intentOf(callback(encodeCallback('approve', ID)));
    expect(intent.kind).toBe('callback');
    if (intent.kind === 'callback') {
      expect(intent.action).toBe('approve');
      expect(intent.contentId).toBe(ID);
      expect(intent.messageId).toBe(42);
    }
  });

  it('ignores anything that is not a command or a decision', () => {
    expect(intentOf(command('just talking')).kind).toBe('ignore');
    expect(intentOf({ update_id: 1 }).kind).toBe('ignore');
    expect(intentOf(callback('something-else')).kind).toBe('ignore');
    expect(intentOf('not an update').kind).toBe('ignore');
  });

  /**
   * Telegram adds fields constantly. A schema that insisted on knowing all of them would
   * start rejecting valid updates the week they ship a new one.
   */
  it('tolerates fields it does not know about', () => {
    const intent = intentOf({
      update_id: 1,
      message: {
        text: '/queue',
        chat: { id: CHAT, type: 'supergroup', title: 'ops' },
        from: { id: ADMIN, is_bot: false, language_code: 'it' },
        some_field_shipped_next_year: true,
      },
    });
    expect(intent.kind).toBe('command');
  });

  it('reports a command it cannot parse', () => {
    const intent = intentOf(command('/nonsense'));
    expect(intent.kind).toBe('unparsed');
  });
});

describe('access control', () => {
  /**
   * Replying "you are not authorised" confirms that a bot exists, is live, and is
   * listening — which is exactly what somebody probing for it wants to learn.
   */
  it('says nothing at all to the wrong chat', async () => {
    const h = harness();
    const result = await dispatch(h.deps, command('/queue', ADMIN, '-100999'));

    expect(result).toMatchObject({ replies: [], handled: false });
    expect(h.log.events('warn')).toContain('telegram.unauthorised-chat');
  });

  it('says nothing to a malformed command from the wrong chat either', async () => {
    const h = harness();
    const result = await dispatch(h.deps, command('/nonsense', ADMIN, '-100999'));
    expect(result.replies).toEqual([]);
  });

  it('does answer a malformed command from the right chat', async () => {
    const h = harness();
    const result = await dispatch(h.deps, command('/nonsense'));
    expect(result.replies).toHaveLength(1);
  });

  /**
   * A keyboard is visible to everyone in the chat, so the right chat is not enough:
   * publishing is held to the same bar as `/promote`.
   */
  it('refuses a decision from a non-admin in the right chat', async () => {
    const h = harness();
    h.content.queue({ id: ID });

    const result = await dispatch(h.deps, callback(encodeCallback('approve', ID), STRANGER));

    expect(h.content.decisions).toEqual([]);
    expect(result.acknowledge?.text).toMatch(/Only the operator/);
  });

  it('drops a decision from the wrong chat silently', async () => {
    const h = harness();
    h.content.queue({ id: ID });

    const result = await dispatch(
      h.deps,
      callback(encodeCallback('approve', ID), ADMIN, '-100999'),
    );

    expect(result).toMatchObject({ replies: [], handled: false });
    expect(h.content.decisions).toEqual([]);
  });
});

describe('the queue', () => {
  it('says so when there is nothing waiting', async () => {
    const h = harness();
    const result = await dispatch(h.deps, command('/queue'));

    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.text).toMatch(/Nothing is waiting/);
    expect(result.replies[0]?.keyboard).toBeUndefined();
  });

  it('sends one card per draft, each with its own buttons', async () => {
    const h = harness();
    h.content.queue({ id: ID });
    h.content.queue({ id: '11111111-2222-3333-4444-555555555555' });

    const result = await dispatch(h.deps, command('/queue'));

    expect(result.replies).toHaveLength(2);
    for (const reply of result.replies) {
      expect(reply.keyboard?.[0]).toHaveLength(2);
    }
  });

  it('bounds how many it sends, because past that the operator is scrolling', async () => {
    const h = harness();
    for (let i = 0; i < QUEUE_PAGE_SIZE + 4; i += 1) {
      h.content.queue({ id: `0000000${String(i)}-1111-2222-3333-444444444444` });
    }

    const result = await dispatch(h.deps, command('/queue'));
    expect(result.replies).toHaveLength(QUEUE_PAGE_SIZE);
  });
});

describe('a card', () => {
  const draft = {
    id: ID,
    slug: 'a-piece',
    title: 'A piece about clustering',
    summary: 'What it says, in one sentence.',
    wordCount: 430,
    sources: [
      { url: 'https://a.example/one', title: 'First source', publisher: 'a.example' },
      { url: 'https://b.example/two', title: 'Second source', publisher: 'b.example' },
    ],
    generatedBy: 'claude-opus-5',
    createdAt: 0,
  };

  /**
   * Listed in full rather than counted: "3 sources" is not something a reviewer can
   * evaluate, and checking them is the entire job being asked of them.
   */
  it('lists every source rather than counting them', () => {
    const rendered = renderDraft(draft, 'https://morph.example');

    for (const source of draft.sources) {
      expect(rendered.text).toContain(source.url);
      expect(rendered.text).toContain(source.publisher);
    }
  });

  it('says a machine wrote it, and offers a preview', () => {
    const rendered = renderDraft(draft, 'https://morph.example');

    expect(rendered.text).toContain('claude-opus-5');
    expect(rendered.text).toContain('https://morph.example/t/a-piece');
    expect(rendered.text).toContain('430');
  });

  it('says so when a human wrote it', () => {
    const rendered = renderDraft({ ...draft, generatedBy: null }, 'https://morph.example');
    expect(rendered.text).toMatch(/by hand/);
  });

  /**
   * MarkdownV2 requires a long list of characters to be escaped, and an unescaped one
   * makes Telegram reject the whole message with a 400 — so a title with a hyphen in it
   * would silently empty the queue.
   */
  it('escapes the characters MarkdownV2 would reject', () => {
    const rendered = renderDraft(
      { ...draft, title: 'Cost-benefit: a study (2026)!', summary: 'A [bracketed] note.' },
      'https://morph.example',
    );

    expect(rendered.text).toContain('\\-');
    expect(rendered.text).toContain('\\(');
    expect(rendered.text).toContain('\\[');
  });

  it('carries the outcome once it has been decided', () => {
    const text = renderDecided(draft, 'approve', ADMIN, new Date(NOW));

    expect(text).toContain('Published');
    expect(text).toContain(ADMIN);
    // The preview link and the source list are gone too: a decided card is a record of
    // what happened, not an invitation to review it again.
    expect(text).not.toContain('morph.example/t/');
    expect(renderDecided(draft, 'reject', ADMIN, new Date(NOW))).toContain('Rejected');
  });
});

describe('deciding', () => {
  it('publishes a draft and rewrites its card in place', async () => {
    const h = harness();
    h.content.queue({ id: ID });

    const result = await dispatch(h.deps, callback(encodeCallback('approve', ID)));

    expect(h.content.decisions).toEqual([{ id: ID, action: 'approve', reviewer: ADMIN }]);
    expect(result.replies[0]?.editMessageId).toBe(42);
    expect(result.replies[0]?.keyboard).toBeUndefined();
    expect(result.acknowledge?.text).toBe('Published.');
  });

  it('rejects a draft', async () => {
    const h = harness();
    h.content.queue({ id: ID });

    const result = await dispatch(h.deps, callback(encodeCallback('reject', ID)));

    expect(h.content.decisions[0]?.action).toBe('reject');
    expect(result.acknowledge?.text).toBe('Rejected.');
  });

  /**
   * The button stays on screen after a tap, so this is the ordinary case rather than an
   * error — and the whole autonomy position depends on approving not being repeatable.
   */
  it('does not publish twice when the button is tapped again', async () => {
    const h = harness();
    h.content.queue({ id: ID });

    await dispatch(h.deps, callback(encodeCallback('approve', ID)));
    const second = await dispatch(h.deps, callback(encodeCallback('approve', ID)));

    expect(h.content.decisions).toHaveLength(1);
    expect(second.acknowledge?.text).toBe('Already decided.');
    expect(second.replies).toEqual([]);
  });

  it('names the reviewer, because the database will not publish without one', async () => {
    const h = harness();
    h.content.queue({ id: ID });

    await dispatch(h.deps, callback(encodeCallback('approve', ID)));
    expect(h.content.decisions[0]?.reviewer).toBe(ADMIN);
  });

  it('says so when the draft has gone', async () => {
    const h = harness();
    const result = await dispatch(h.deps, callback(encodeCallback('approve', ID)));

    expect(result.acknowledge?.text).toMatch(/no longer exists/);
    expect(result.replies).toEqual([]);
  });
});

describe('commands that are not wired yet', () => {
  /**
   * A command that does nothing and says nothing is indistinguishable from a bot that has
   * crashed, and the operator's next move would be to restart something that is working.
   */
  it('names itself rather than failing silently', async () => {
    const h = harness();
    const result = await dispatch(h.deps, command('/trends'));

    expect(result.replies[0]?.text).toMatch(/not wired yet/);
    expect(result.handled).toBe(true);
  });

  it('answers /status with the command list, which is true', async () => {
    const h = harness();
    const result = await dispatch(h.deps, command('/status'));

    expect(result.replies[0]?.text).toContain('queue');
  });

  it('refuses a mutating command from a non-admin', async () => {
    const h = harness();
    const result = await dispatch(h.deps, command('/kill', STRANGER));

    expect(result.replies[0]?.text).toMatch(/limited to the operator/);
  });
});

// -----------------------------------------------------------------------------

describe('the Bot API client', () => {
  interface Call {
    readonly method: string;
    readonly body: Record<string, unknown>;
  }

  function stub(calls: Call[], replies: readonly unknown[]): typeof globalThis.fetch {
    let index = 0;
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = url.split('/').pop() ?? '';
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
      calls.push({ method, body });

      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return Promise.resolve(new Response(JSON.stringify(reply)));
    };
  }

  const sent = { ok: true, result: { message_id: 7 } };

  const client = (calls: Call[], replies: readonly unknown[], slept: number[] = []) =>
    telegramClient({
      botToken: 'token',
      chatId: CHAT,
      fetch: stub(calls, replies),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

  it('sends MarkdownV2 with previews off', async () => {
    const calls: Call[] = [];
    await client(calls, [sent]).send('hello');

    expect(calls[0]?.method).toBe('sendMessage');
    expect(calls[0]?.body['parse_mode']).toBe('MarkdownV2');
    expect(calls[0]?.body['link_preview_options']).toEqual({ is_disabled: true });
  });

  /**
   * A report is longer than 4096 characters, which is a hard API limit.
   */
  it('splits a message that exceeds the limit', async () => {
    const calls: Call[] = [];
    const ids = await client(calls, [sent]).send('x'.repeat(9000));

    expect(calls.length).toBeGreaterThan(1);
    expect(ids.length).toBe(calls.length);
  });

  /**
   * The buttons belong under the whole message, not in the middle of it.
   */
  it('attaches the keyboard to the last chunk only', async () => {
    const calls: Call[] = [];
    await client(calls, [sent]).send('x'.repeat(9000), [[{ text: 'ok', callback_data: 'a:b' }]]);

    expect(calls[0]?.body['reply_markup']).toBeUndefined();
    expect(calls.at(-1)?.body['reply_markup']).toBeDefined();
  });

  /**
   * The specific bug this client exists to not have: the Bot API reports errors in the
   * body with HTTP 200, so checking `response.ok` treats every failure as a success.
   */
  it('treats ok:false as a failure even though the HTTP status is 200', async () => {
    await expect(
      client([], [{ ok: false, description: 'chat not found' }]).send('hello'),
    ).rejects.toThrow(/chat not found/);
  });

  it('waits out a 429 and retries', async () => {
    const slept: number[] = [];
    const calls: Call[] = [];

    await client(calls, [{ ok: false, parameters: { retry_after: 4 } }, sent], slept).send('hi');

    // A second of padding: arriving at exactly `retry_after` earns a second 429.
    expect(slept).toEqual([5000]);
    expect(calls).toHaveLength(2);
  });

  it('gives up rather than retrying a rate limit forever', async () => {
    const slept: number[] = [];

    await expect(
      client([], [{ ok: false, parameters: { retry_after: 1 }, description: 'flood' }], slept).send(
        'hi',
      ),
    ).rejects.toThrow(/rate limited/);

    expect(slept).toHaveLength(MAX_RATE_LIMIT_RETRIES);
  });

  /**
   * Omitting `reply_markup` leaves the old keyboard in place, and the whole point of
   * editing a decided card is that its buttons go away.
   */
  it('clears the keyboard when editing a decided card', async () => {
    const calls: Call[] = [];
    await client(calls, [{ ok: true, result: {} }]).edit(42, 'Published');

    expect(calls[0]?.method).toBe('editMessageText');
    expect(calls[0]?.body['reply_markup']).toEqual({ inline_keyboard: [] });
  });

  it('asks only for the update types it can act on', async () => {
    const calls: Call[] = [];
    await client(calls, [{ ok: true, result: [] }]).poll(0);

    expect(calls[0]?.method).toBe('getUpdates');
    expect(calls[0]?.body['allowed_updates']).toEqual(['message', 'callback_query']);
  });

  it('returns updates with their ids, so the offset can advance', async () => {
    const updates = await client(
      [],
      [{ ok: true, result: [{ update_id: 11, message: {} }, { update_id: 12 }] }],
    ).poll(0);

    expect(updates.map((u) => u.update_id)).toEqual([11, 12]);
  });
});

describe('the prose prompt', () => {
  const facts = {
    ...SAMPLE_REPORT_INPUT,
    alerts: [
      { severity: 'critical' as const, title: 'clickhouse is down', detail: 'connection refused' },
    ],
  };

  /**
   * The model is asked to write about *this message*, so it is given the rendered text
   * rather than the underlying facts — which is what makes "copy the figures exactly as
   * written" a checkable instruction rather than an invitation to reformat.
   */
  it('hands over the report as the reader will see it', () => {
    const prompt = promptFor('*MORPH*\n1.8k sessions', facts);
    expect(prompt).toContain('1.8k sessions');
  });

  /**
   * A report whose lead does not mention that ClickHouse is down is a lead that has failed
   * at its only job.
   */
  it('repeats the alerts separately so they cannot be buried', () => {
    const prompt = promptFor('a report', facts);

    expect(prompt).toContain('[critical] clickhouse is down');
    expect(prompt).toMatch(/must not be buried/);
  });

  it('says so plainly when there is nothing wrong', () => {
    const prompt = promptFor('a report', { ...SAMPLE_REPORT_INPUT, alerts: [] });
    expect(prompt).toContain('None.');
  });
});
