/**
 * Asking Claude for the report's lead.
 *
 * The model is given the deterministic report as it will be sent, and asked for two to
 * four sentences to sit on top of it. It is not asked to rewrite anything: the nine
 * sections go out exactly as composed, and the lead is the part that can be dropped
 * without loss.
 *
 * WHY THE PROMPT AND THE CHECK SAY THE SAME THING
 * The instruction "only use figures that appear in the report" is in the prompt because a
 * model that knows the rule follows it most of the time, and in `verifyLead` because
 * "most of the time" is not a property you can put in a compliance document. The prompt
 * makes the check rarely fire; the check is what makes the prompt's failure harmless.
 *
 * The model is told what happens when it cannot say anything useful, and given permission
 * to say so briefly. A model that believes it must produce insight will produce insight.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ReportInput } from '@morph/telegram';

export interface ProseWriter {
  /** Which model writes the lead, for `report_run.composed_by_model`. */
  readonly model: string;
  /** The lead, or `null` when the model had nothing usable to say. */
  lead(report: string, facts: ReportInput): Promise<string | null>;
}

export interface ProseConfig {
  readonly apiKey: string;
  readonly model: string;
}

const SYSTEM = `You write the opening lines of an hourly operations report for one reader:
the person who runs this system. They will read the full report underneath your lines, so
your job is not to summarise it — it is to say what actually matters about this hour.

Rules:

- Two to four sentences. Under 600 characters. No headings, no lists, no greeting.
- Use only figures that appear verbatim in the report below. Copy them exactly as written,
  including the units. Never compute a new figure, a ratio, a total or an average, even
  when the arithmetic is obvious.
- Never state a cause. You can see what changed, not why. "Sign-ups fell" is reporting;
  "sign-ups fell because of the new headline" is a guess that will be believed.
- If the hour was unremarkable, say so in one sentence. That is the correct answer most
  nights and it is more useful than a manufactured observation.
- Lead with whatever the reader would want to know first, which is usually the thing that
  moved most or the thing that needs them.
- Plain declarative English. No "notably", no "it's worth noting", no rhetorical questions.

Write only the lines. Nothing before or after them.`;

export function anthropicProse(config: ProseConfig): ProseWriter {
  const client = new Anthropic({ apiKey: config.apiKey });

  return {
    model: config.model,

    async lead(report: string, facts: ReportInput): Promise<string | null> {
      const response = await client.messages.create({
        model: config.model,
        // Small: the output is four sentences. A larger ceiling would only buy the model
        // room to write something that then fails the length check.
        max_tokens: 512,
        system: SYSTEM,
        messages: [{ role: 'user', content: promptFor(report, facts) }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      return text === '' ? null : text;
    },
  };
}

/**
 * The prompt.
 *
 * The report is handed over as the escaped MarkdownV2 that will actually be sent, rather
 * than as the underlying facts. That is deliberate: the model is being asked to write
 * *about this message*, and giving it the rendered text is what makes "copy the figures
 * exactly as written" a checkable instruction rather than an invitation to reformat.
 *
 * The alert titles are repeated separately because they are the one thing that must not be
 * buried — a report whose lead does not mention that ClickHouse is down is a lead that has
 * failed at its only job.
 */
export function promptFor(report: string, facts: ReportInput): string {
  const alerts =
    facts.alerts.length === 0
      ? 'None.'
      : facts.alerts.map((alert) => `- [${alert.severity}] ${alert.title}`).join('\n');

  return [
    'Here is the report that is about to be sent, exactly as the reader will see it.',
    '',
    '---',
    report,
    '---',
    '',
    'Active alerts, which must not be buried if there are any:',
    alerts,
    '',
    'Write the opening lines.',
  ].join('\n');
}
