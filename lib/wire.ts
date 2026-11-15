// wire.ts — penerjemah dua wire klien dan satu wire hulu.
//
// Klien berbicara OpenAI (POST /v1/chat/completions) atau Anthropic
// (POST /v1/messages); gateway hanya berbicara Chat Completions. File ini
// menerjemahkan body Anthropic menjadi body Chat Completions, dan jawaban
// Chat Completions — JSON maupun SSE — kembali ke wire peminta.
//
// Satu aturan yang tak pernah dilanggar di sini: field `model` pada
// SETIAP jawaban dan SETIAP chunk adalah id yang benar-benar didial
// server ini. Jawaban provider mengeja model tanpa awalan "openrouter/",
// jadi id dial selalu ditulis ulang di atasnya, tidak pernah diteruskan
// apa adanya.
//
// Semua penerjemahan murni: tanpa jam, tanpa acak. Cap waktu daftar model
// adalah konstanta tetap supaya byte jawabannya stabil antar putaran.

import { isObj, type JsonObj } from './brief.ts';

/** Bentuk ringkas satu model untuk GET /v1/models. */
export interface ListedModel {
  id: string;
  label: string;
}

const LIST_CREATED_EPOCH = 1767225600; // cap tetap, bukan jam berjalan
const LIST_CREATED_ISO = '2026-01-01T00:00:00Z';
/** Cap keluaran bawaan bila klien tidak menamai satu pun (gateway menolak tanpa cap). */
export const FALLBACK_MAX_TOKENS = 1024;
/** Cap keluaran terbesar yang gateway terima. */
export const GATEWAY_MAX_TOKENS = 8192;

const numOr0 = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Teks polos dari konten string atau array blok teks; '' bila tak ada. */
function plainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isObj(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** Daftar model gaya OpenAI. */
export function chatModelList(models: readonly ListedModel[]): JsonObj {
  return {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: LIST_CREATED_EPOCH,
      owned_by: 'openrouter',
    })),
  };
}

/** Daftar model gaya Anthropic. */
export function messagesModelList(models: readonly ListedModel[]): JsonObj {
  return {
    data: models.map((m) => ({
      type: 'model',
      id: m.id,
      display_name: m.label,
      created_at: LIST_CREATED_ISO,
    })),
    has_more: false,
    first_id: models.length > 0 ? models[0].id : null,
    last_id: models.length > 0 ? models[models.length - 1].id : null,
  };
}

/** Amplop error gaya OpenAI. */
export function chatError(message: string, type: string, code: string | null): JsonObj {
  return { error: { message, type, code } };
}

/** Amplop error gaya Anthropic. */
export function messagesError(type: string, message: string): JsonObj {
  return { type: 'error', error: { type, message } };
}

/** Pastikan body Chat Completions punya cap keluaran yang gateway terima. */
export function ensureOutputCap(body: JsonObj): JsonObj {
  const out = { ...body };
  const cap =
    typeof out.max_tokens === 'number'
      ? out.max_tokens
      : typeof out.max_completion_tokens === 'number'
        ? out.max_completion_tokens
        : null;
  if (cap === null) out.max_tokens = FALLBACK_MAX_TOKENS;
  else if (cap > GATEWAY_MAX_TOKENS) {
    if (typeof out.max_tokens === 'number') out.max_tokens = GATEWAY_MAX_TOKENS;
    else out.max_completion_tokens = GATEWAY_MAX_TOKENS;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Anthropic -> OpenAI (arah permintaan)
// ---------------------------------------------------------------------------

/** Satu blok gambar Anthropic menjadi part image_url OpenAI; null bila bukan. */
function imagePart(block: JsonObj): JsonObj | null {
  if (block.type !== 'image' || !isObj(block.source)) return null;
  const source = block.source;
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** Isi tool_result menjadi teks: blok teksnya, atau JSON dari sisanya. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = plainText(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/**
 * Body Messages menjadi body Chat Completions yang menamai `modelId`:
 * system menjadi pesan system, tool_use menjadi tool_calls, tool_result
 * menjadi pesan tool, definisi tools dan tool_choice ditulis ulang, dan
 * parameter sampling diteruskan.
 */
export function messagesToChat(body: JsonObj, modelId: string): JsonObj {
  const messages: JsonObj[] = [];
  const systemText = plainText(body.system);
  if (systemText !== '') messages.push({ role: 'system', content: systemText });

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of incoming) {
    if (!isObj(raw)) continue;
    const isAssistant = raw.role === 'assistant';
    if (typeof raw.content === 'string') {
      messages.push({ role: isAssistant ? 'assistant' : 'user', content: raw.content });
      continue;
    }
    if (!Array.isArray(raw.content)) continue;

    if (isAssistant) {
      const calls: JsonObj[] = [];
      for (const block of raw.content) {
        if (!isObj(block) || block.type !== 'tool_use') continue;
        calls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isObj(block.input) ? block.input : {}),
          },
        });
      }
      const text = plainText(raw.content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }

    // Pesan user: tool_result keluar sebagai pesan tool tersendiri,
    // blok teks/gambar berkumpul menjadi satu pesan user.
    const parts: JsonObj[] = [];
    for (const block of raw.content) {
      if (!isObj(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: toolResultText(block.content),
        });
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
        continue;
      }
      const image = imagePart(block);
      if (image !== null) parts.push(image);
    }
    if (parts.length === 1 && parts[0].type === 'text') {
      messages.push({ role: 'user', content: parts[0].text });
    } else if (parts.length > 0) {
      messages.push({ role: 'user', content: parts });
    }
  }

  const out: JsonObj = { model: modelId, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences;
  }
  if (Array.isArray(body.tools)) {
    const tools: JsonObj[] = [];
    for (const rawTool of body.tools) {
      if (!isObj(rawTool) || typeof rawTool.name !== 'string') continue;
      tools.push({
        type: 'function',
        function: {
          name: rawTool.name,
          description: typeof rawTool.description === 'string' ? rawTool.description : '',
          parameters: isObj(rawTool.input_schema)
            ? rawTool.input_schema
            : { type: 'object', properties: {} },
        },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }
  if (isObj(body.tool_choice)) {
    const choice = body.tool_choice;
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'none') out.tool_choice = 'none';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return ensureOutputCap(out);
}

// ---------------------------------------------------------------------------
// OpenAI -> Anthropic (arah jawaban, non-streaming)
// ---------------------------------------------------------------------------

/** finish_reason OpenAI menjadi stop_reason Anthropic. */
export function toStopReason(finish: unknown): string {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/** Argumen tool call (string JSON) menjadi objek input Anthropic. */
function parseToolInput(value: unknown): JsonObj {
  if (isObj(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isObj(parsed)) return parsed;
    } catch {
      // Bukan JSON: input kosong.
    }
  }
  return {};
}

/** Jawaban Chat Completions (JSON) menjadi objek Messages. */
export function chatToMessage(answer: JsonObj, modelId: string): JsonObj {
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const first = isObj(choices[0]) ? choices[0] : {};
  const message = isObj(first.message) ? first.message : {};

  const content: JsonObj[] = [];
  const text = typeof message.content === 'string' ? message.content : plainText(message.content);
  if (text !== '') content.push({ type: 'text', text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isObj(call) || !isObj(call.function)) continue;
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' && call.id !== '' ? call.id : 'toolu_1',
      name: typeof call.function.name === 'string' ? call.function.name : '',
      input: parseToolInput(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const usage = isObj(answer.usage) ? answer.usage : {};
  const upstreamId = typeof answer.id === 'string' ? answer.id.replace(/[^A-Za-z0-9_-]/g, '') : '';
  return {
    id: upstreamId !== '' ? `msg_${upstreamId}` : 'msg_aggregated',
    type: 'message',
    role: 'assistant',
    model: modelId,
    content,
    stop_reason: toStopReason(first.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: numOr0(usage.prompt_tokens),
      output_tokens: numOr0(usage.completion_tokens),
    },
  };
}

/** Jawaban Chat Completions dengan field model diganti id yang didial. */
export function stampChatAnswer(answer: JsonObj, modelId: string): JsonObj {
  return { ...answer, model: modelId };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Satu event SSE lengkap (baris event opsional + data + baris kosong). */
function sseFrame(event: string | null, data: unknown): string {
  const head = event === null ? '' : `event: ${event}\n`;
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}

/** Membaca stream byte menjadi frame-frame SSE mentah (teks per frame). */
async function* readSseFrames(
  upstream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let cut = pending.indexOf('\n\n');
      while (cut !== -1) {
        yield pending.slice(0, cut);
        pending = pending.slice(cut + 2);
        cut = pending.indexOf('\n\n');
      }
    }
    pending += decoder.decode();
    if (pending.trim() !== '') yield pending;
  } finally {
    reader.releaseLock();
  }
}

/** Payload data: dari satu frame mentah; null untuk komentar/[DONE]/rusak. */
function framePayload(frame: string): JsonObj | null {
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') return null;
    try {
      const parsed: unknown = JSON.parse(payload);
      return isObj(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

const frameIsDone = (frame: string): boolean => frame.includes('[DONE]');

/**
 * Relay stream Chat Completions apa adanya, kecuali field model di setiap
 * payload data diganti id yang didial. Frame [DONE] diteruskan utuh.
 */
export async function* relayChatStream(
  upstream: ReadableStream<Uint8Array>,
  modelId: string,
): AsyncGenerator<string> {
  for await (const frame of readSseFrames(upstream)) {
    if (frameIsDone(frame)) {
      yield 'data: [DONE]\n\n';
      continue;
    }
    const payload = framePayload(frame);
    if (payload === null) continue;
    yield `data: ${JSON.stringify({ ...payload, model: modelId })}\n\n`;
  }
}

/**
 * Stream Chat Completions menjadi urutan event Messages:
 * message_start, lalu per blok content_block_start/delta/stop, ditutup
 * message_delta (stop_reason + usage akhir) dan message_stop. Alasan
 * berhenti ditahan sampai chunk usage terakhir tiba, karena OpenAI
 * mengirim finish_reason sebelum usage-nya.
 */
export async function* chatStreamToMessageEvents(
  upstream: ReadableStream<Uint8Array>,
  modelId: string,
): AsyncGenerator<string> {
  let begun = false;
  let closed = false;
  let heldStop: string | null = null;
  let inTokens = 0;
  let outTokens = 0;
  let textBlockAt = -1;
  let nextBlockAt = 0;
  const toolBlockAt = new Map<number, number>();

  const opening = (): string[] => {
    if (begun) return [];
    begun = true;
    return [
      sseFrame('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_streamed',
          type: 'message',
          role: 'assistant',
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inTokens, output_tokens: 0 },
        },
      }),
    ];
  };

  const closings = (): string[] => {
    const out: string[] = [];
    if (textBlockAt !== -1) {
      out.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: textBlockAt }));
      textBlockAt = -1;
    }
    const toolIndexes = [...toolBlockAt.values()].sort((a, b) => a - b);
    for (const index of toolIndexes) {
      out.push(sseFrame('content_block_stop', { type: 'content_block_stop', index }));
    }
    toolBlockAt.clear();
    return out;
  };

  const ending = (): string[] => {
    if (closed) return [];
    closed = true;
    return [
      ...closings(),
      sseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: heldStop ?? 'end_turn', stop_sequence: null },
        usage: { output_tokens: outTokens },
      }),
      sseFrame('message_stop', { type: 'message_stop' }),
    ];
  };

  for await (const frame of readSseFrames(upstream)) {
    if (frameIsDone(frame)) {
      for (const event of opening()) yield event;
      for (const event of ending()) yield event;
      continue;
    }
    const chunk = framePayload(frame);
    if (chunk === null) continue;
    if (isObj(chunk.usage)) {
      inTokens = numOr0(chunk.usage.prompt_tokens);
      outTokens = numOr0(chunk.usage.completion_tokens);
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isObj(choices[0]) ? choices[0] : null;
    if (choice === null) continue;
    for (const event of opening()) yield event;

    const delta = isObj(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (textBlockAt === -1) {
        textBlockAt = nextBlockAt++;
        yield sseFrame('content_block_start', {
          type: 'content_block_start',
          index: textBlockAt,
          content_block: { type: 'text', text: '' },
        });
      }
      yield sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: textBlockAt,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    const deltaCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const call of deltaCalls) {
      if (!isObj(call)) continue;
      const upstreamAt = typeof call.index === 'number' ? call.index : toolBlockAt.size;
      let blockAt = toolBlockAt.get(upstreamAt);
      if (blockAt === undefined) {
        if (textBlockAt !== -1) {
          yield sseFrame('content_block_stop', {
            type: 'content_block_stop',
            index: textBlockAt,
          });
          textBlockAt = -1;
        }
        blockAt = nextBlockAt++;
        toolBlockAt.set(upstreamAt, blockAt);
        const fn = isObj(call.function) ? call.function : {};
        yield sseFrame('content_block_start', {
          type: 'content_block_start',
          index: blockAt,
          content_block: {
            type: 'tool_use',
            id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${blockAt}`,
            name: typeof fn.name === 'string' ? fn.name : '',
            input: {},
          },
        });
      }
      const fn = isObj(call.function) ? call.function : {};
      if (typeof fn.arguments === 'string' && fn.arguments !== '') {
        yield sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: blockAt,
          delta: { type: 'input_json_delta', partial_json: fn.arguments },
        });
      }
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      heldStop = toStopReason(choice.finish_reason);
    }
  }

  if (!closed) {
    for (const event of opening()) yield event;
    for (const event of ending()) yield event;
  }
}

// ---------------------------------------------------------------------------
// Jejak failover
// ---------------------------------------------------------------------------

/** Satu baris jejak penolakan untuk header x-makefun-upstream-failures. */
export interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/**
 * Kode penolakan dari body error gateway: error.code bila ada, lalu
 * error.type, terakhir "http_<status>". Body yang bukan JSON tetap
 * menghasilkan kode yang stabil.
 */
export function failureCodeOf(status: number, bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isObj(parsed) && isObj(parsed.error)) {
      if (typeof parsed.error.code === 'string' && parsed.error.code !== '') {
        return parsed.error.code;
      }
      if (typeof parsed.error.code === 'number') return String(parsed.error.code);
      if (typeof parsed.error.type === 'string' && parsed.error.type !== '') {
        return parsed.error.type;
      }
    }
  } catch {
    // Body bukan JSON; jatuh ke kode bawaan di bawah.
  }
  return `http_${status}`;
}
