// Aturan kuota mingguan, dipisah supaya bisa diuji tanpa browser.

// Kelebihan minggu lalu memotong kuota minggu ini, maksimal MAX_CUT dari kuota; sisanya dibawa ke minggu
// berikutnya. Sisa hemat TIDAK menambah kuota minggu depan, tapi dikumpulkan sebagai "hemat bulan ini".
export const MAX_CUT = 0.5;

/**
 * base: kuota mingguan penuh. pastSpent: pengeluaran tiap minggu sebelumnya di bulan berjalan (urut).
 * Hasil: potongan untuk minggu ini, sisa potongan yang masih dibawa, dan total hemat bulan ini.
 */
export function carryOver(base, pastSpent) {
  let carry = 0, savedMonth = 0;
  for (const spent of pastSpent) {
    const cut = Math.min(carry, base * MAX_CUT);
    carry -= cut;
    carry += Math.max(0, spent - (base - cut));
    savedMonth += Math.max(0, base - cut - spent);
  }
  const cut = Math.min(carry, base * MAX_CUT);
  return { cut, carryLeft: carry - cut, savedMonth };
}
