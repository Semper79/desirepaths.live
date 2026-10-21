/**
 * Who the data controller is (D4).
 *
 * GDPR Art. 13 requires that a visitor be told the identity and contact details of the
 * controller **before** their data is processed. `docs/PRIVACY.md` has carried that as an
 * open decision since Phase 0 and the page has been publishable-but-incomplete for as
 * long — which is the worst of the three possible states, because it looks finished.
 *
 * WHY THIS LIVES IN `core` AND NOT IN `apps/web`
 * Two services need the same answer and they need to agree. The renderer needs it to
 * publish the notice; the collector needs it to decide whether it is allowed to measure
 * anybody at all. A copy in each would be two things to keep in step, and the one that
 * drifted would be the one that said "configured" while the other said "not".
 *
 * WHY AN ABSENT CONTROLLER IS A HARD FAILURE AND NOT A WARNING
 * The tempting shape is a placeholder: render "Controller: TBD", log a warning, carry on.
 * That produces a site which measures visitors while telling them nothing, which is the
 * precise thing the regulation forbids — and it would be discovered by somebody other
 * than the operator. So the absence is enforced instead: the collector refuses to accept
 * events and `/ready` refuses the deployment. A site that cannot name its controller does
 * not get to have visitors.
 *
 * This is the same treatment `apps/worker/src/env.ts` already gives the deterministic
 * embedding provider: a component that is meaningless in production is made impossible
 * rather than discouraged.
 *
 * NOTHING HERE IS INVENTED
 * There is no default, no example value and no fallback. Three facts are needed and only
 * the operator has them; a plausible-looking placeholder in a privacy notice is a false
 * legal record, and a false legal record is worse than a missing one.
 */

import { z } from 'zod';

/**
 * The three facts Art. 13(1)(a) and (b) require.
 *
 * `address` is a single string rather than structured fields on purpose. A controller can
 * be a company with a registered office or a private individual at their residence, and
 * the formats are not the same shape in different countries — splitting it would force
 * every operator into one jurisdiction's idea of an address.
 */
export const ControllerSchema = z.object({
  /** Legal entity name, or the individual's name where there is no company. */
  name: z.string().min(2).max(200),
  /** Registered office, or residence for a sole trader or private individual. */
  address: z.string().min(5).max(500),
  /**
   * Where a data-subject request goes. Art. 15 and Art. 17 are exercised against this
   * address, so a mailbox nobody reads is a compliance failure with a working SMTP server.
   */
  email: z.string().email().max(200),
  /**
   * An Art. 37 DPO, where one has been appointed.
   *
   * Optional because most operators do not need one. It stops being optional if processing
   * becomes "regular and systematic monitoring on a large scale" — which the 5M events/day
   * design target plausibly is. See `docs/PRIVACY.md`.
   */
  dpoEmail: z.string().email().max(200).optional(),
});

export type Controller = z.infer<typeof ControllerSchema>;

export interface ControllerSource {
  readonly MORPH_CONTROLLER_NAME?: string | undefined;
  readonly MORPH_CONTROLLER_ADDRESS?: string | undefined;
  readonly MORPH_CONTROLLER_EMAIL?: string | undefined;
  readonly MORPH_CONTROLLER_DPO_EMAIL?: string | undefined;
}

/**
 * The controller, or `null` when it has not been configured.
 *
 * Parsed rather than cast, so a half-filled configuration is `null` and not a `Controller`
 * with an empty name. Returning `null` for partial input is deliberate: three fields that
 * must all be present are one fact, not three, and a notice naming a controller with no
 * contact address satisfies nothing.
 */
export function controllerFrom(source: ControllerSource): Controller | null {
  const parsed = ControllerSchema.safeParse({
    name: source.MORPH_CONTROLLER_NAME,
    address: source.MORPH_CONTROLLER_ADDRESS,
    email: source.MORPH_CONTROLLER_EMAIL,
    ...(source.MORPH_CONTROLLER_DPO_EMAIL === undefined ||
    source.MORPH_CONTROLLER_DPO_EMAIL.length === 0
      ? {}
      : { dpoEmail: source.MORPH_CONTROLLER_DPO_EMAIL }),
  });

  return parsed.success ? parsed.data : null;
}

/**
 * Which fields are missing, for a readiness probe to report.
 *
 * "Not ready" with no reason sends somebody into the code at the worst moment. This names
 * the variables so the message is actionable from the probe output alone.
 */
export function missingControllerFields(source: ControllerSource): readonly string[] {
  const required: readonly (keyof ControllerSource)[] = [
    'MORPH_CONTROLLER_NAME',
    'MORPH_CONTROLLER_ADDRESS',
    'MORPH_CONTROLLER_EMAIL',
  ];

  const absent = required.filter((key) => (source[key] ?? '').length === 0);
  if (absent.length > 0) return absent;

  // Everything is present but something does not parse — a malformed email, most likely.
  // Reported as the whole set rather than guessed at, because the parse is the authority.
  return controllerFrom(source) === null ? required : [];
}
