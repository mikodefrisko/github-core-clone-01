// Entrypoint: join the trial harness, serve until it says stop.
//
// The scoring harness ("the env") lives at MAKEFUN_ENV_URL and cannot reach
// this process until we hand it the port we bound. The whole job of this
// file is that handshake, then waiting:
//   1. Read MAKEFUN_ENV_URL. With no env to talk to there is nothing to do,
//      so bail out with exit code 1 right away.
//   2. Build the server (app.ts) and bind an ephemeral port. Never 8080 —
//      the env owns that one. The kernel picks the free port.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records the
//      address the request came from plus N and dials it from then on. The
//      first register wins; a 409 means another entry already registered,
//      and this process just keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//      answers immediately ({"done": false} while the suite runs), so this is
//      a poll, not a long-held request. A failed or slow poll is retried with
//      a short exponential backoff; the process never exits early.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// Nothing else is imported here: only our own server, no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

/** One register or done request may take this long before it is abandoned. */
const FETCH_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

/** The env origin, or null when MAKEFUN_ENV_URL is missing or blank. */
function readOrigin(): string | null {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  return raw === '' ? null : raw;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `failures` failed attempts: doubles from the first pause, capped. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

/**
 * Run `work` until it reports success, sleeping longer after each failure.
 * `work` returns true when its job is done; anything else (false, or a
 * thrown error) means "try again". Contract errors are the caller's to
 * throw — they escape this loop and end the program.
 */
async function retryUntilDone(work: () => Promise<boolean>): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      if (await work()) return;
    } catch (err) {
      // A contract error thrown by work ends the program, not the retry.
      if (err instanceof Error && err.message.startsWith('fatal: ')) throw err;
    }
    await sleep(backoffMs(failures));
  }
}

/**
 * One register attempt. True means the env accepted the port (200) or
 * another entry already won the race (409). A 400 or 405 is a contract
 * error and ends the program; any other status or network failure just
 * means "retry", since the env may still be starting.
 */
async function tryRegister(origin: string, port: number): Promise<boolean> {
  const res = await fetch(`${origin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 200 || res.status === 409) return true;
  if (res.status === 400 || res.status === 405) {
    throw new Error(`fatal: register answered HTTP ${res.status}: ${await res.text()}`);
  }
  return false;
}

/** One done poll: true only when the env answers {"done": true}. */
async function tryDone(origin: string): Promise<boolean> {
  const res = await fetch(`${origin}/done`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { done?: unknown };
  return body.done === true;
}

/** Bind the port, register it, then wait for the env: the life of the process. */
async function boot(): Promise<void> {
  const origin = readOrigin();
  if (origin === null) {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await retryUntilDone(() => tryRegister(origin, bound.port));
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await retryUntilDone(() => tryDone(origin));
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
