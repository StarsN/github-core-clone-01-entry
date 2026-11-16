// Entry point for the forge: this file owns only the conversation with the
// trial environment. The application itself lives behind createApp() in
// app.ts; everything here is about announcing the port we bound, then
// staying alive until the environment tells us the trial is finished.
//
// The conversation, in order:
//   1. MAKEFUN_ENV_URL says where the environment listens. No URL, no
//      trial: complain on stderr and exit 1 immediately.
//   2. Bind port 0 so the kernel picks a free port (never 8080: that one
//      belongs to the environment), then POST that port to /register.
//   3. Poll GET /done until it answers {"done": true}. Only then close
//      the server and exit 0; exiting earlier would end the trial early.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set, so there is no environment to register with\n');
  process.exit(1);
}

// One register or poll request gets this long before it counts as failed.
const REQUEST_TIMEOUT_MS = 30_000;
// Backoff between retries: starts at FIRST_RETRY_MS, doubles each round,
// and never waits longer than MAX_RETRY_MS.
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait before retry number `attempt` (0-based): 250, 500, 1000, 2000, 2000…
function backoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
}

// POST the bound port to the environment until it accepts the registration.
// 200 means registered; 409 means another process registered first, which
// is equally final as far as we are concerned. 400 and 405 are contract
// errors — the request itself is wrong — so they abort the program. Any
// other outcome (odd status, timeout, connection refused while the
// environment is still starting) is retried with backoff.
async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused the request with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // Network trouble or a timeout: fall through and try again.
    }
    await pause(backoffMs(attempt));
  }
}

// Poll /done until the environment ends the trial. The endpoint answers
// immediately with {"done": false} while the suite is still running, so
// this is a poll loop, not a long-held request; failed polls are retried
// the same way and never cause an early exit.
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Unreachable or slow environment: not done, so keep polling.
    }
    await pause(backoffMs(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  process.stdout.write(`[entry] forge listening on port ${address.port}\n`);

  await registerPort(address.port);
  process.stdout.write('[entry] registered with the environment; holding until it says done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] environment said done; shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
