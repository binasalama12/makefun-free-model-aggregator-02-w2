// main.ts — Failover-First Aggregator: server tipis, logika di lib/.
//
// Alur hidup proses:
//   1. Baca brief dari $MAKEFUN_PROMPT_FILE, bangun katalog darinya.
//      Dengan --list: cetak katalog itu persis (byte per byte sama dengan
//      yang diregister) lalu exit 0, sebelum server apa pun menyala.
//   2. Dengarkan 0.0.0.0 di port bebas dari OS (tidak pernah 8080).
//   3. POST $MAKEFUN_ENV_URL/register {protocol_version, port, catalog}.
//   4. Layani GET /v1/models, POST /v1/chat/completions, POST /v1/messages.
//      Tiap request "auto" dirutekan lib/router.ts ke model free terbaik
//      yang memenuhi kebutuhannya, didial lewat gateway, dan — bila
//      gateway menolak — digeser ke kandidat berikutnya (failover) dengan
//      cooldown tetap per model dari lib/cooldown.ts.
//   5. Poll GET $MAKEFUN_ENV_URL/work tiap 100 ms; exit 0 saat done.
//
// Determinisme: tak ada jam dinding dan tak ada acak di jalur keputusan;
// urutan panggilan hanya fungsi dari request dan jawaban gateway.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  catalogFrom,
  isObj,
  loadModels,
  type CatalogDoc,
  type FreeModel,
  type JsonObj,
} from './lib/brief.ts';
import { CooldownLedger } from './lib/cooldown.ts';
import { needFromChatBody, needFromMessagesBody, orderedCandidates } from './lib/router.ts';
import {
  chatError,
  chatModelList,
  chatStreamToMessageEvents,
  chatToMessage,
  ensureOutputCap,
  failureCodeOf,
  messagesError,
  messagesModelList,
  messagesToChat,
  relayChatStream,
  stampChatAnswer,
  type FailureRow,
} from './lib/wire.ts';

const PROTOCOL_VERSION = 1;
const POLL_MS = 100;
const BODY_LIMIT = 8 * 1024 * 1024;
const TRAIL_HEADER = 'x-makefun-upstream-failures';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const gatewayBase = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const gatewayKey = process.env.OPENAI_API_KEY ?? '';

const allModels: FreeModel[] = loadModels(process.env.MAKEFUN_PROMPT_FILE ?? '');
const theCatalog: CatalogDoc = catalogFrom(allModels);
const ledger = new CooldownLedger();

const note = (msg: string): void => {
  process.stderr.write(`failover-first: ${msg}\n`);
};

/** URL rute Chat Completions di gateway, dari OPENAI_BASE_URL apa pun ejaannya. */
function gatewayChatUrl(): string {
  if (gatewayBase === '') return '';
  return gatewayBase.endsWith('/v1')
    ? `${gatewayBase}/chat/completions`
    : `${gatewayBase}/v1/chat/completions`;
}

/** Model yang dilayani, dalam urutan katalog, untuk GET /v1/models. */
function listedModels(): { id: string; label: string }[] {
  const provider = theCatalog.providers[0];
  if (provider === undefined) return [];
  const labelById = new Map(allModels.map((m) => [m.id, m.label]));
  return provider.models.map((m) => ({ id: m.id, label: labelById.get(m.id) ?? m.id }));
}

/** Baca satu body JSON klien; null bila bukan satu objek JSON / terlalu besar. */
async function readBody(req: IncomingMessage): Promise<JsonObj | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

/** Header jejak failover, hanya bila ada penolakan yang berhasil dilewati. */
function trailHeaders(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { [TRAIL_HEADER]: JSON.stringify(failures.slice(0, 8)) };
}

function replyJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function replyError(
  res: ServerResponse,
  wire: 'chat' | 'messages',
  status: number,
  type: string,
  message: string,
  extra: Record<string, string> = {},
): void {
  if (wire === 'messages') replyJson(res, status, messagesError(type, message), extra);
  else replyJson(res, status, chatError(message, type, null), extra);
}

/** Satu panggilan gateway untuk `modelId` dengan body Chat Completions. */
async function dialOnce(modelId: string, chatBody: JsonObj, wantsStream: boolean): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${gatewayKey}`,
  };
  if (wantsStream) headers.accept = 'text/event-stream';
  return fetch(gatewayChatUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...chatBody, model: modelId }),
  });
}

interface DialOutcome {
  upstream: Response;
  servedBy: string;
  failures: FailureRow[];
}

/**
 * Mendial kandidat berurutan sampai satu menjawab OK. Setiap penolakan
 * (status tak-OK, body streaming hilang, body JSON rusak, jaringan putus)
 * dicatat ke jejak, modelnya masuk cooldown, dan kandidat berikut dicoba.
 * Mengembalikan null bila semua kandidat menolak.
 */
async function dialWithFailover(
  candidates: FreeModel[],
  makeBody: (modelId: string) => JsonObj,
  wantsStream: boolean,
  ordinal: number,
): Promise<DialOutcome | null> {
  const failures: FailureRow[] = [];
  for (const candidate of candidates) {
    ledger.noteDial(candidate.id);
    let upstream: Response;
    try {
      upstream = await dialOnce(candidate.id, makeBody(candidate.id), wantsStream);
    } catch (err) {
      failures.push({ status: 502, code: 'network_error', model: candidate.id });
      ledger.noteRefusal(candidate.id, ordinal);
      note(`dial ${candidate.id} failed: ${(err as Error).message}`);
      continue;
    }
    if (!upstream.ok || upstream.body === null) {
      const text = upstream.body === null ? '' : await upstream.text().catch(() => '');
      failures.push({
        status: upstream.status,
        code: failureCodeOf(upstream.status, text),
        model: candidate.id,
      });
      ledger.noteRefusal(candidate.id, ordinal);
      continue;
    }
    ledger.noteSuccess(candidate.id);
    return { upstream, servedBy: candidate.id, failures };
  }
  return null;
}

/** Buka respons streaming klien dengan header yang benar + jejak failover. */
function openStream(res: ServerResponse, failures: FailureRow[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...trailHeaders(failures),
  });
}

/** POST /v1/chat/completions — klien OpenAI, jawaban OpenAI. */
async function serveChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (body === null) {
    return replyError(res, 'chat', 400, 'invalid_request_error', 'request body is not one JSON object');
  }
  const ordinal = ledger.beginRequest();
  const wantsStream = body.stream === true;
  const requested = typeof body.model === 'string' ? body.model : '';
  const candidates = orderedCandidates(
    allModels,
    needFromChatBody(body),
    ledger,
    ordinal,
    requested,
  );
  if (candidates.length === 0) {
    return replyError(res, 'chat', 503, 'no_free_model', 'no free model meets this request');
  }

  // Untuk jawaban non-streaming, body hulu dibaca sebagai teks dulu supaya
  // JSON rusak bisa diperlakukan sebagai penolakan dan dialihkan.
  if (!wantsStream) {
    const failures: FailureRow[] = [];
    for (const candidate of candidates) {
      ledger.noteDial(candidate.id);
      let upstream: Response;
      try {
        upstream = await dialOnce(candidate.id, ensureOutputCap({ ...body }), false);
      } catch (err) {
        failures.push({ status: 502, code: 'network_error', model: candidate.id });
        ledger.noteRefusal(candidate.id, ordinal);
        note(`dial ${candidate.id} failed: ${(err as Error).message}`);
        continue;
      }
      const text = await upstream.text().catch(() => '');
      if (!upstream.ok) {
        failures.push({
          status: upstream.status,
          code: failureCodeOf(upstream.status, text),
          model: candidate.id,
        });
        ledger.noteRefusal(candidate.id, ordinal);
        continue;
      }
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        failures.push({ status: 502, code: 'invalid_upstream_body', model: candidate.id });
        ledger.noteRefusal(candidate.id, ordinal);
        continue;
      }
      ledger.noteSuccess(candidate.id);
      return replyJson(
        res,
        200,
        stampChatAnswer(isObj(answer) ? answer : {}, candidate.id),
        trailHeaders(failures),
      );
    }
    return replyError(
      res,
      'chat',
      502,
      'upstream_error',
      'every free model refused this request',
      trailHeaders(failures),
    );
  }

  const outcome = await dialWithFailover(
    candidates,
    () => ensureOutputCap({ ...body, stream: true, stream_options: { ...(isObj(body.stream_options) ? body.stream_options : {}), include_usage: true } }),
    true,
    ordinal,
  );
  if (outcome === null) {
    return replyError(res, 'chat', 502, 'upstream_error', 'every free model refused this request');
  }
  openStream(res, outcome.failures);
  try {
    for await (const frame of relayChatStream(outcome.upstream.body as ReadableStream<Uint8Array>, outcome.servedBy)) {
      res.write(frame);
    }
  } finally {
    res.end();
  }
}

/** POST /v1/messages — klien Anthropic, diterjemahkan dua arah. */
async function serveMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (body === null) {
    return replyError(res, 'messages', 400, 'invalid_request_error', 'request body is not one JSON object');
  }
  const ordinal = ledger.beginRequest();
  const wantsStream = body.stream === true;
  const requested = typeof body.model === 'string' ? body.model : '';
  const candidates = orderedCandidates(
    allModels,
    needFromMessagesBody(body),
    ledger,
    ordinal,
    requested,
  );
  if (candidates.length === 0) {
    return replyError(res, 'messages', 503, 'overloaded_error', 'no free model meets this request');
  }

  if (!wantsStream) {
    const failures: FailureRow[] = [];
    for (const candidate of candidates) {
      ledger.noteDial(candidate.id);
      let upstream: Response;
      try {
        upstream = await dialOnce(candidate.id, messagesToChat(body, candidate.id), false);
      } catch (err) {
        failures.push({ status: 502, code: 'network_error', model: candidate.id });
        ledger.noteRefusal(candidate.id, ordinal);
        note(`dial ${candidate.id} failed: ${(err as Error).message}`);
        continue;
      }
      const text = await upstream.text().catch(() => '');
      if (!upstream.ok) {
        failures.push({
          status: upstream.status,
          code: failureCodeOf(upstream.status, text),
          model: candidate.id,
        });
        ledger.noteRefusal(candidate.id, ordinal);
        continue;
      }
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        failures.push({ status: 502, code: 'invalid_upstream_body', model: candidate.id });
        ledger.noteRefusal(candidate.id, ordinal);
        continue;
      }
      ledger.noteSuccess(candidate.id);
      return replyJson(
        res,
        200,
        chatToMessage(isObj(answer) ? answer : {}, candidate.id),
        trailHeaders(failures),
      );
    }
    return replyError(
      res,
      'messages',
      502,
      'api_error',
      'every free model refused this request',
      trailHeaders(failures),
    );
  }

  const outcome = await dialWithFailover(
    candidates,
    (modelId) => messagesToChat(body, modelId),
    true,
    ordinal,
  );
  if (outcome === null) {
    return replyError(res, 'messages', 502, 'api_error', 'every free model refused this request');
  }
  openStream(res, outcome.failures);
  try {
    for await (const event of chatStreamToMessageEvents(outcome.upstream.body as ReadableStream<Uint8Array>, outcome.servedBy)) {
      res.write(event);
    }
  } finally {
    res.end();
  }
}

/** GET /v1/models — bentuk mengikuti header auth yang datang. */
function serveModels(req: IncomingMessage, res: ServerResponse): void {
  const models = listedModels();
  if (typeof req.headers['x-api-key'] === 'string') {
    replyJson(res, 200, messagesModelList(models));
  } else {
    replyJson(res, 200, chatModelList(models));
  }
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://aggregator');
  if (req.method === 'GET' && url.pathname === '/v1/models') return serveModels(req, res);
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return serveChat(req, res);
  if (req.method === 'POST' && url.pathname === '/v1/messages') return serveMessages(req, res);
  const wire = url.pathname === '/v1/messages' ? 'messages' : 'chat';
  return replyError(res, wire, 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

/** POST /register ke env dengan katalog yang sama persis dengan --list. */
async function registerWithEnv(port: number): Promise<void> {
  const res = await fetch(`${envBase}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: theCatalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`register answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const reply: unknown = await res.json().catch(() => null);
  if (isObj(reply) && typeof reply.requests === 'number') {
    note(`registered on port ${port}; trial holds ${reply.requests} prompts`);
  }
}

/** Poll /work tiap 100 ms; exit 0 begitu env menyatakan selesai. */
function pollWork(server: ReturnType<typeof createServer>): void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const res = await fetch(`${envBase}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const work: unknown = await res.json().catch(() => null);
          if (isObj(work) && work.done === true) {
            clearInterval(timer);
            server.close();
            process.exit(0);
          }
        }
      } catch {
        // Env belum terjangkau; coba lagi pada tick berikutnya.
      } finally {
        busy = false;
      }
    })();
  }, POLL_MS);
}

async function boot(): Promise<void> {
  if (process.argv.includes('--list')) {
    // Dokumen yang sama dengan yang diregister — objek yang sama,
    // serialisasi yang sama — dicetak lalu proses berhenti.
    const text = `${JSON.stringify(theCatalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (envBase === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (gatewayChatUrl() === '') throw new Error('OPENAI_BASE_URL is not set');

  const server = createServer((req, res) => {
    void dispatch(req, res).catch((err: unknown) => {
      note((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        replyError(
          res,
          req.url?.startsWith('/v1/messages') ? 'messages' : 'chat',
          500,
          'internal_error',
          'the server failed to answer',
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  if (address.port === 8080) throw new Error('OS assigned 8080, which belongs to the env');
  note(`listening on 0.0.0.0:${address.port} with ${listedModels().length} free models`);
  await registerWithEnv(address.port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  pollWork(server);
}

try {
  await boot();
} catch (err) {
  note((err as Error).stack ?? String(err));
  process.exit(1);
}
