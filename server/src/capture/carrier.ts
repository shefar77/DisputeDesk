/**
 * Carrier tracking-page capture (FR-6, PRD §14 KERNEL).
 *
 * KERNEL configured -> a Kernel cloud browser loads the carrier's public tracking
 *                      page and returns its rendered text plus a screenshot. The
 *                      Playwright code runs inside Kernel's VM; there is no local
 *                      Chromium and no CDP socket for us to manage.
 * Demo mode         -> the fixture scenario's page text, marked as fixture.
 * Neither           -> a clean "not available" result, and the workflow falls
 *                      back to PayPal tracking data / manual upload (J2).
 *
 * SSRF control (PRD §18): a URL is only ever opened if its host is on the carrier
 * allow-list, and the URL is checked *before* it is interpolated into the code we
 * send to Kernel. The interpolation itself goes through JSON.stringify so a
 * crafted URL cannot break out of the string literal.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Kernel from '@onkernel/sdk';
import { env, isAllowedCarrierHost } from '../env.js';
import { logger } from '../log.js';
import { getDemoGateway } from '../paypal/index.js';
import { sha256 } from '../paypal/payload.js';

export interface CaptureResult {
  ok: boolean;
  url: string | null;
  text: string | null;
  screenshotPath: string | null;
  screenshotBytes: number | null;
  liveViewUrl: string | null;
  provider: 'kernel' | 'fixture' | 'none';
  /** Why it failed — shown verbatim in the UI's degraded-state banner. */
  reason: string | null;
  httpStatus: number | null;
  durationMs: number;
}

/** Public tracking-page URL templates. Host must also be on the allow-list. */
const CARRIER_URLS: Record<string, (n: string) => string> = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  FEDEX: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  DHL: (n) => `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
  ROYAL_MAIL: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`,
  PARCELFORCE: (n) => `https://www.parcelforce.com/track-trace?trackNumber=${encodeURIComponent(n)}`,
  CA_CANADA_POST: (n) =>
    `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${encodeURIComponent(n)}`,
};

export function trackingUrlFor(carrierEnum: string | null, trackingNumber: string | null): string | null {
  if (!carrierEnum || !trackingNumber) return null;
  const build = CARRIER_URLS[carrierEnum];
  return build ? build(trackingNumber) : null;
}

export function kernelConfigured(): boolean {
  return Boolean(env.kernel.apiKey);
}

/**
 * Runs inside Kernel's browser VM, where `page` is in scope. Kept as a template
 * so the only dynamic value is the JSON-encoded URL.
 */
function captureScript(url: string): string {
  return `
const target = ${JSON.stringify(url)};
const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);
const status = response ? response.status() : null;
const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
const shot = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
return { status, text: text.slice(0, 20000), screenshot: shot.toString('base64'), finalUrl: page.url() };
`.trim();
}

/** Heuristic for bot walls: a 403/429, or a page that is all challenge text. */
function looksBlocked(status: number | null, text: string): boolean {
  if (status === 403 || status === 429) return true;
  const t = text.toLowerCase();
  return (
    text.trim().length < 40 ||
    /access denied|are you a robot|verify you are human|captcha|unusual traffic|request blocked/.test(t)
  );
}

function saveScreenshot(disputeId: string, base64: string): { path: string; bytes: number } {
  mkdirSync(env.storage.capturesDir, { recursive: true });
  const buf = Buffer.from(base64, 'base64');
  // Random-looking, content-derived name: never derived from the carrier URL.
  const name = `${disputeId.replace(/[^A-Za-z0-9-]/g, '')}-${sha256(buf).slice(0, 16)}.jpg`;
  const path = join(env.storage.capturesDir, name);
  writeFileSync(path, buf);
  return { path, bytes: buf.byteLength };
}

export async function captureCarrierPage(disputeId: string, url: string | null): Promise<CaptureResult> {
  const started = Date.now();
  const fail = (reason: string, provider: CaptureResult['provider'], extra: Partial<CaptureResult> = {}): CaptureResult => ({
    ok: false,
    url,
    text: null,
    screenshotPath: null,
    screenshotBytes: null,
    liveViewUrl: null,
    provider,
    reason,
    httpStatus: null,
    durationMs: Date.now() - started,
    ...extra,
  });

  // --- demo mode: fixture page ------------------------------------------------
  const demo = getDemoGateway();
  if (demo) {
    const page = demo.scenarioFor(disputeId)?.carrierPage ?? null;
    if (!page) return fail('No carrier tracking page for this dispute (no tracking number on record)', 'fixture');
    if (page.blocked) {
      return fail(
        `Carrier page refused automated access (HTTP ${page.httpStatus ?? 403})`,
        'fixture',
        { url: page.url, httpStatus: page.httpStatus ?? 403 },
      );
    }
    return {
      ok: true,
      url: page.url,
      text: page.text,
      screenshotPath: null,
      screenshotBytes: null,
      liveViewUrl: null,
      provider: 'fixture',
      reason: null,
      httpStatus: 200,
      durationMs: Date.now() - started,
    };
  }

  // --- live capture ---------------------------------------------------------
  if (!url) return fail('No tracking URL could be built for this carrier', 'none');
  if (!isAllowedCarrierHost(url)) {
    // SSRF control: this is a refusal, not a soft failure, and it is logged.
    logger.warn({ disputeId, host: safeHost(url) }, 'Refused to capture a non-allow-listed host');
    return fail(`Host ${safeHost(url)} is not on the carrier allow-list`, 'none');
  }
  if (!env.kernel.apiKey) {
    return fail('KERNEL_API_KEY is not set — carrier capture is disabled', 'none');
  }

  const kernel = new Kernel({ apiKey: env.kernel.apiKey });
  let sessionId: string | null = null;
  let liveViewUrl: string | null = null;

  try {
    const browser = await kernel.browsers.create({ timeout_seconds: 120, stealth: true });
    sessionId = browser.session_id;
    liveViewUrl = browser.browser_live_view_url ?? null;
    logger.info({ disputeId, sessionId }, 'Kernel browser started for carrier capture');

    const exec = await kernel.browsers.playwright.execute(sessionId, {
      code: captureScript(url),
      timeout_sec: Math.ceil(env.kernel.timeoutMs / 1000),
    });

    if (!exec.success) {
      return fail(`Capture script failed: ${(exec.error ?? 'unknown error').slice(0, 200)}`, 'kernel', { liveViewUrl });
    }

    const result = (exec.result ?? {}) as { status?: number | null; text?: string; screenshot?: string };
    const text = result.text ?? '';
    const status = result.status ?? null;

    let shot: { path: string; bytes: number } | null = null;
    if (result.screenshot) shot = saveScreenshot(disputeId, result.screenshot);

    if (looksBlocked(status, text)) {
      return fail(
        `Carrier page appears to block automated access${status ? ` (HTTP ${status})` : ''}`,
        'kernel',
        { liveViewUrl, httpStatus: status, screenshotPath: shot?.path ?? null, screenshotBytes: shot?.bytes ?? null },
      );
    }

    return {
      ok: true,
      url,
      text,
      screenshotPath: shot?.path ?? null,
      screenshotBytes: shot?.bytes ?? null,
      liveViewUrl,
      provider: 'kernel',
      reason: null,
      httpStatus: status,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return fail(`Kernel error: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`, 'kernel', { liveViewUrl });
  } finally {
    if (sessionId) {
      await kernel.browsers.deleteByID(sessionId).catch((err: unknown) => {
        logger.warn({ sessionId, err: err instanceof Error ? err.message : err }, 'Failed to delete Kernel browser');
      });
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(invalid url)';
  }
}
