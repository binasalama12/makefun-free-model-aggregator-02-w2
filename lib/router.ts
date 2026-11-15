// router.ts — memilih model untuk satu request ("Failover-First").
//
// Urutan pikirnya:
//   1. Baca kebutuhan DARI request itu sendiri: tools yang dideklarasikan
//      menuntut model ber-tools, response_format JSON menuntut model
//      ber-JSON, blok gambar menuntut model ber-vision. Kemampuan yang
//      brief tulis null (tidak dinyatakan) dianggap TIDAK dimiliki —
//      lebih aman gagal memilih daripada mendial model yang tak mampu.
//   2. Buang model yang sedang cooldown (lihat cooldown.ts). Bila semua
//      model layak sedang cooldown, daftar layak penuh dipakai lagi
//      sebagai jalan terakhir: request tak boleh terdampar hanya karena
//      cooldown, selama ada model yang mampu melayaninya.
//   3. Urutkan sisanya: rating_milli tertinggi dulu; seri dipecahkan oleh
//      jumlah panggilan tersedikit sejauh ini; seri terakhir oleh id
//      menaik supaya hasilnya deterministik penuh.
// Hasilnya adalah daftar kandidat berurutan: main.ts mendial dari kepala
// daftar dan hanya turun ke kandidat berikut bila gateway menolak.

import { isObj, type FreeModel, type JsonObj, type Need } from './brief.ts';
import type { CooldownLedger } from './cooldown.ts';

const NO_NEED: Need = { tools: false, vision: false, json: false };

/** Apakah satu blok konten pesan adalah gambar (kedua wire diperiksa). */
function blockIsImage(block: unknown): boolean {
  if (!isObj(block)) return false;
  return block.type === 'image' || block.type === 'image_url';
}

/** Pindai pesan-pesan gaya OpenAI untuk kebutuhan vision. */
function chatNeedsVision(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isObj(message) || !Array.isArray(message.content)) continue;
    if (message.content.some(blockIsImage)) return true;
  }
  return false;
}

/** Kebutuhan dari body POST /v1/chat/completions. */
export function needFromChatBody(body: JsonObj): Need {
  const format = isObj(body.response_format) ? body.response_format.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision: chatNeedsVision(body.messages),
    json: format === 'json_object' || format === 'json_schema',
  };
}

/** Kebutuhan dari body POST /v1/messages (wire Anthropic tak punya JSON mode). */
export function needFromMessagesBody(body: JsonObj): Need {
  let vision = false;
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObj(message) || !Array.isArray(message.content)) continue;
      if (message.content.some(blockIsImage)) vision = true;
    }
  }
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: false,
  };
}

/** Apakah model memenuhi kebutuhan; kemampuan tak dinyatakan = tak dimiliki. */
export function satisfies(model: FreeModel, need: Need): boolean {
  if (need.tools && model.canTools !== true) return false;
  if (need.vision && model.canVision !== true) return false;
  if (need.json && model.canJson !== true) return false;
  return true;
}

/**
 * Daftar kandidat berurutan untuk satu request. `requestedModel` adalah
 * nilai field model dari klien: "auto" (atau kosong) berarti router bebas
 * memilih; id katalog yang eksplisit didahulukan, dengan daftar rating
 * sebagai rantai failover di belakangnya.
 */
export function orderedCandidates(
  models: readonly FreeModel[],
  need: Need,
  ledger: CooldownLedger,
  ordinal: number,
  requestedModel: string,
): FreeModel[] {
  const eligible = models.filter((m) => m.isFree && satisfies(m, need));
  if (eligible.length === 0) return [];

  const fresh = eligible.filter((m) => !ledger.isCooling(m.id, ordinal));
  const pool = fresh.length > 0 ? fresh : eligible;

  const ranked = [...pool].sort((a, b) => {
    if (b.ratingMilli !== a.ratingMilli) return b.ratingMilli - a.ratingMilli;
    const byDials = ledger.dialCount(a.id) - ledger.dialCount(b.id);
    if (byDials !== 0) return byDials;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (requestedModel !== '' && requestedModel !== 'auto') {
    const pinned = ranked.findIndex((m) => m.id === requestedModel);
    if (pinned > 0) {
      const [head] = ranked.splice(pinned, 1);
      ranked.unshift(head);
    }
  }
  return ranked;
}

export { NO_NEED };
