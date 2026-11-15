// cooldown.ts — buku cooldown Failover-First Aggregator.
//
// Prinsipnya sederhana dan disengaja kaku: SETIAP penolakan gateway
// (HTTP 429, 5xx, atau jaringan putus) membuat model yang menolak masuk
// cooldown selama rentang TETAP yang dihitung dalam jumlah request klien,
// bukan detik. Menghitung dengan ordinal request — bukan jam dinding —
// membuat perilaku server fungsi murni dari urutan request dan jawaban
// gateway, jadi putaran replay menghasilkan jejak panggilan yang sama.
//
// Buku ini juga menghitung berapa kali tiap model sudah didial. Angka itu
// dipakai router sebagai pemecah seri: di antara model ber-rating sama,
// yang paling sedikit didial didahulukan, supaya beban menyebar dan model
// populer tidak habis kuotanya lebih dulu.

/** Berapa request klien berikutnya yang dilewati model sesudah menolak. */
export const COOLDOWN_SPAN_REQUESTS = 2;

export class CooldownLedger {
  /** Ordinal request yang sedang berjalan (0 = belum ada request). */
  #ordinal = 0;
  /** modelId -> total panggilan gateway yang pernah dicoba. */
  #dialCounts = new Map<string, number>();
  /** modelId -> ordinal request saat penolakan terakhirnya tercatat. */
  #lastRefusalAt = new Map<string, number>();

  /** Memulai satu request klien baru; mengembalikan ordinalnya. */
  beginRequest(): number {
    this.#ordinal += 1;
    return this.#ordinal;
  }

  /** Mencatat satu panggilan gateway ke model ini (sukses atau tidak). */
  noteDial(modelId: string): void {
    this.#dialCounts.set(modelId, (this.#dialCounts.get(modelId) ?? 0) + 1);
  }

  /** Mencatat penolakan: model masuk cooldown tetap mulai ordinal ini. */
  noteRefusal(modelId: string, ordinal: number): void {
    this.#lastRefusalAt.set(modelId, ordinal);
  }

  /** Mencatat keberhasilan. Versi awal: catatan penolakan dibiarkan utuh. */
  noteSuccess(_modelId: string): void {
    // Sengaja kosong di versi awal — lihat riwayat commit untuk revisinya.
  }

  /** Total panggilan ke model ini sejauh trial berjalan. */
  dialCount(modelId: string): number {
    return this.#dialCounts.get(modelId) ?? 0;
  }

  /**
   * Apakah model sedang cooldown pada ordinal `ordinal`: benar bila
   * penolakan terakhirnya terjadi pada request ini atau dalam
   * COOLDOWN_SPAN_REQUESTS request terakhir.
   */
  isCooling(modelId: string, ordinal: number): boolean {
    const refusedAt = this.#lastRefusalAt.get(modelId);
    if (refusedAt === undefined) return false;
    const gap = ordinal - refusedAt;
    return gap >= 0 && gap <= COOLDOWN_SPAN_REQUESTS;
  }
}
