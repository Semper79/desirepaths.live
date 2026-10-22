/**
 * The data controller, and the states it is allowed to be in (D4).
 *
 * There are only two: fully configured, or absent. The whole point of these cases is that
 * there is no third — no partially configured controller, no placeholder, no "name set but
 * contact missing". A notice naming a controller nobody can write to satisfies nothing Art.
 * 13 asks for, and the enforcement elsewhere (the collector refusing beacons, `/ready`
 * refusing the deployment) is only coherent if "configured" means all of it.
 */

import { describe, expect, it } from 'vitest';
import { controllerFrom, missingControllerFields } from '../src/controller';

const COMPLETE = {
  MORPH_CONTROLLER_NAME: 'Example Operator Srl',
  MORPH_CONTROLLER_ADDRESS: 'Via Esempio 1, 24100 Bergamo, Italy',
  MORPH_CONTROLLER_EMAIL: 'privacy@example.org',
};

describe('controllerFrom', () => {
  it('reads a complete configuration', () => {
    const controller = controllerFrom(COMPLETE);

    expect(controller?.name).toBe('Example Operator Srl');
    expect(controller?.email).toBe('privacy@example.org');
    expect(controller?.dpoEmail).toBeUndefined();
  });

  it('carries a data protection officer when one is appointed', () => {
    const controller = controllerFrom({
      ...COMPLETE,
      MORPH_CONTROLLER_DPO_EMAIL: 'dpo@example.org',
    });

    expect(controller?.dpoEmail).toBe('dpo@example.org');
  });

  it('treats an empty DPO address as no DPO rather than as a malformed one', () => {
    // The realistic shape of an unset variable in a deployment: present and empty, not
    // absent. Failing the whole parse over it would make an optional field mandatory.
    const controller = controllerFrom({ ...COMPLETE, MORPH_CONTROLLER_DPO_EMAIL: '' });

    expect(controller).not.toBeNull();
    expect(controller?.dpoEmail).toBeUndefined();
  });

  it('is null when nothing is configured', () => {
    expect(controllerFrom({})).toBeNull();
  });

  it('is null when any single field is missing', () => {
    // Built by filtering rather than by deleting a computed key: the entries form is
    // exactly as clear and does not need an eslint exception to say so.
    for (const omitted of Object.keys(COMPLETE)) {
      const partial = Object.fromEntries(
        Object.entries(COMPLETE).filter(([key]) => key !== omitted),
      );

      expect(controllerFrom(partial), `without ${omitted}`).toBeNull();
    }
  });

  it('is null when the contact address is not an address', () => {
    // The field that matters most, because it is the one a data subject actually uses.
    expect(controllerFrom({ ...COMPLETE, MORPH_CONTROLLER_EMAIL: 'privacy' })).toBeNull();
    expect(controllerFrom({ ...COMPLETE, MORPH_CONTROLLER_EMAIL: 'privacy@' })).toBeNull();
  });

  it('refuses values too short to be a real name or address', () => {
    // Guards against the placeholder a hurried deploy reaches for: a single character, or
    // a dash meaning "fill this in later".
    expect(controllerFrom({ ...COMPLETE, MORPH_CONTROLLER_NAME: '-' })).toBeNull();
    expect(controllerFrom({ ...COMPLETE, MORPH_CONTROLLER_ADDRESS: 'n/a' })).toBeNull();
  });
});

describe('missingControllerFields', () => {
  it('is empty when the controller is configured', () => {
    expect(missingControllerFields(COMPLETE)).toEqual([]);
  });

  it('names every absent variable, so a probe output is actionable', () => {
    expect(missingControllerFields({})).toEqual([
      'MORPH_CONTROLLER_NAME',
      'MORPH_CONTROLLER_ADDRESS',
      'MORPH_CONTROLLER_EMAIL',
    ]);
  });

  it('names the one that is absent', () => {
    expect(missingControllerFields({ ...COMPLETE, MORPH_CONTROLLER_EMAIL: '' })).toEqual([
      'MORPH_CONTROLLER_EMAIL',
    ]);
  });

  it('reports the whole set when everything is present but something does not parse', () => {
    // A malformed value is not a missing one, and guessing which field the parse objected
    // to would be a second implementation of the schema. Naming all three is honest about
    // what is known: the configuration is wrong somewhere in here.
    expect(missingControllerFields({ ...COMPLETE, MORPH_CONTROLLER_EMAIL: 'nope' })).toHaveLength(
      3,
    );
  });
});
