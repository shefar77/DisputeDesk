/** Gateway factory — the one place demo and sandbox diverge. */

import { env } from '../env.js';
import { logger } from '../log.js';
import { DemoPayPal } from './demo.js';
import { LivePayPal } from './live.js';
import type { PayPalGateway } from './gateway.js';

let gateway: PayPalGateway | null = null;

export function initPayPal(): PayPalGateway {
  if (gateway) return gateway;

  if (env.isDemo) {
    logger.info({ reason: env.demoReason }, 'PayPal gateway: DEMO mode (fixtures, no outbound calls)');
    gateway = new DemoPayPal();
  } else {
    logger.info({ baseUrl: env.paypal.baseUrl }, 'PayPal gateway: SANDBOX mode');
    gateway = new LivePayPal(
      env.paypal.clientId!,
      env.paypal.clientSecret!,
      env.paypal.baseUrl,
    );
  }
  return gateway;
}

export function getPayPal(): PayPalGateway {
  if (!gateway) throw new Error('PayPal gateway not initialised — call initPayPal() during boot.');
  return gateway;
}

/** Demo-only accessor for the fixture scenarios the workflow steps read. */
export function getDemoGateway(): DemoPayPal | null {
  return gateway instanceof DemoPayPal ? gateway : null;
}

export * from './gateway.js';
export * from './types.js';
export { DemoPayPal } from './demo.js';
export { LivePayPal } from './live.js';
