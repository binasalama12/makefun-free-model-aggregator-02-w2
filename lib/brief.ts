// brief.ts — membaca brief trial dan menurunkan katalog darinya.
//
// Brief di $MAKEFUN_PROMPT_FILE adalah prosa yang menyisipkan dokumen JSON.
// Dokumen yang dicari di sini adalah daftar model bebas skema
// "free-model-aggregator-02/models/v1": tiap baris membawa id yang bisa
// didial gateway, rating_milli, kemampuan (tools/vision/json), panjang
// konteks, dan flag free. Katalog TIDAK pernah ditulis tangan di kode:
// ia selalu dibangun dari baris-baris brief, jadi instance mana pun yang
// digambar generator menghasilkan katalog yang benar untuk instance itu.
//
// Semua fungsi di file ini murni terhadap isi brief — tanpa jam dinding,
// tanpa acak — sehingga dokumen katalog hasil --list dan hasil register
// identik byte per byte, di putaran live maupun replay.

import { readFileSync } from 'node:fs';

/** Objek JSON polos. */
export type JsonObj = Record<string, unknown>;

export const isObj = (v: unknown): v is JsonObj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Satu model bebas persis seperti yang brief daftarkan. */
export interface FreeModel {
  /** Id yang didial gateway, mis. "openrouter/<vendor>/<model>:free". */
  id: string;
  /** Nama tampil dari brief (dipakai daftar model gaya Anthropic). */
  label: string;
  /** Rating kualitas rumah dalam milli-point; makin besar makin baik. */
  ratingMilli: number;
  contextLength: number | null;
  canTools: boolean | null;
  canVision: boolean | null;
  canJson: boolean | null;
  isFree: boolean;
}

/** Kebutuhan satu request: kemampuan yang wajib dimiliki model pelayan. */
export interface Need {
  tools: boolean;
  vision: boolean;
  json: boolean;
}

/** Dokumen katalog: satu-satunya bentuk yang dicetak --list dan diregister. */
export interface CatalogDoc {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: 'openai';
    models: Array<{ id: string; free: boolean; context_length: number | null }>;
  }>;
}

const SCHEMA_TAG = 'free-model-aggregator-02/';
export const PROVIDER_BASE_URL = 'https://openrouter.ai/api/v1';
export const PROVIDER_KEY_ENV = 'OPENROUTER_API_KEY';

/** Indeks kurung tutup dari objek yang dibuka di `open`, sadar isi string. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\') i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Semua objek JSON di prosa brief yang membawa `schema` kontes ini. */
function briefDocuments(text: string): JsonObj[] {
  const found: JsonObj[] = [];
  for (let at = text.indexOf('{'); at !== -1; at = text.indexOf('{', at + 1)) {
    const end = closingBrace(text, at);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(at, end + 1));
      if (isObj(value) && typeof value.schema === 'string' && value.schema.includes(SCHEMA_TAG)) {
        found.push(value);
      }
    } catch {
      // Potongan ini bukan JSON yang berdiri sendiri; lanjutkan memindai.
    }
  }
  return found;
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Satu baris model mentah menjadi FreeModel; null bila baris tak bisa didial. */
function toFreeModel(raw: unknown): FreeModel | null {
  if (!isObj(raw)) return null;
  let id = asStr(raw.id) || asStr(raw.model);
  if (id === '') return null;
  const vendor = asStr(raw.provider) || asStr(raw.wire);
  // Brief kadang menulis id polos tanpa awalan gateway; samakan ejaannya.
  if (vendor === 'openrouter' && !id.startsWith('openrouter/')) id = `openrouter/${id}`;
  return {
    id,
    label: asStr(raw.display_name) || id,
    ratingMilli: asNum(raw.rating_milli) ?? 0,
    contextLength: asNum(raw.context_length),
    canTools: asBool(raw.tools),
    canVision: asBool(raw.vision),
    canJson: asBool(raw.json),
    isFree: raw.free !== false,
  };
}

/**
 * Daftar model dari brief di `path`. Brief yang hilang/rusak menghasilkan
 * daftar kosong (dan katalog kosong), bukan crash: --list tetap exit 0.
 */
export function loadModels(path: string): FreeModel[] {
  if (path === '') return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  for (const doc of briefDocuments(text)) {
    const rows = Array.isArray(doc.models) ? doc.models : Array.isArray(doc.ratings) ? doc.ratings : null;
    if (rows === null) continue;
    const models: FreeModel[] = [];
    for (const row of rows) {
      const model = toFreeModel(row);
      if (model !== null) models.push(model);
    }
    return models;
  }
  return [];
}

/**
 * Katalog dari daftar model: tepat model-model free, sekali masing-masing,
 * urutan mengikuti brief. Urutan ini juga urutan GET /v1/models.
 */
export function catalogFrom(models: readonly FreeModel[]): CatalogDoc {
  const seen = new Set<string>();
  const rows: CatalogDoc['providers'][number]['models'] = [];
  for (const model of models) {
    if (!model.isFree || seen.has(model.id)) continue;
    seen.add(model.id);
    rows.push({ id: model.id, free: true, context_length: model.contextLength });
  }
  if (rows.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: PROVIDER_BASE_URL,
        key_env: PROVIDER_KEY_ENV,
        wire: 'openai',
        models: rows,
      },
    ],
  };
}
