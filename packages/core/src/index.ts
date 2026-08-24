/**
 * @morph/core - the shared vocabulary of the system.
 *
 * If two packages need to agree on a shape, it is defined here. Nothing in this
 * package performs I/O, reads the environment, or imports another workspace package.
 */

export * from './brand.js';
export * from './color.js';
export * from './text.js';
export * from './consent.js';
export * from './context.js';
export * from './events.js';
export * from './config.js';
export * from './surfaces/index.js';
