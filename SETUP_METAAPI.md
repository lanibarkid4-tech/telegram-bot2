# 🔧 PANDUAN SETUP METAAPI.CLOUD — Step by Step

MetaAPI.cloud adalah **REST API untuk MetaTrader 4/5** yang memungkinkan bot lo ambil data XAU/USD **langsung dari broker MT5 lo** (bukan third-party seperti Yahoo/Twelve Data).

> **Gratis**: 100,000 credit unit/bulan (cukup untuk 1 bot running 24/7 selama ±1-2 tahun)

---

## 📋 TAHAP 1: Daftar MetaAPI.cloud

1. Buka **https://app.metaapi.cloud**
2. Klik **"Sign Up"** (pojok kanan atas)
3. Isi email + password, atau sign up dengan **Google/GitHub**
4. **Verifikasi email** kamu (cek inbox)
5. Setelah login, kamu akan masuk ke **Dashboard**

---

## 📋 TAHAP 2: Ambil API Token

1. Di Dashboard, klik **ikon profil** (kanan atas) → **"API tokens"**
2. Klik tombol **"+ Create token"** atau **"Generate new token"**
3. Isi:
   - **Name**: `telegram-bot-xauusd` (nama bebas)
   - **Scopes**: centang semua (atau minimal `accounts:read`, `mt-read`)
4. Klik **"Create"**
5. **COPY TOKEN** yang muncul — format seperti:
   ```
   01a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z7
   ```
   ⚠️ **Token cuma muncul SEKALI**. Kalau hilang, harus generate ulang.

---

## 📋 TAHAP 3: Tambah MetaTrader 5 Account

Kamu butuh **akun MT5** (bisa paper trading / demo). Ada 2 opsi:

### Opsi A: Pakai Demo Account dari MetaQuotes (PALING GAMPANG)

1. Buka **https://www.metatrader5.com** → download MT5
2. Buka MT5 → **File → Open an Account** (atau **Buka akun trading**)
3. Pilih **MetaQuotes Software Corp** → **Demo account** (akun tanpa uang real)
4. Isi form (nama, email, no HP, deposit virtual $10000)
5. Setelah dapat akun, di MT5 klik **Tools → Options → Email** atau lihat di **Navigator → Accounts**:
   - **Login** (angka): contoh `12345678`
   - **Password**: yang lo set
   - **Server**: `MetaQuotes-Demo` (atau yang muncul)

### Opsi B: Pakai Broker MT5 Real/Paper Trading

Broker populer yang support MT5:
- **IC Markets**, **Exness**, **XM**, **Pepperstone**, **FBS**, **OctaFX**, dll
- Buka akun **paper trading/demo** di broker tersebut
- Ambil login, password, dan server name

> **Penting untuk XAU/USD**: pastikan broker lo punya **XAUUSD** (atau **XAUUSDm**, **XAUUSD.r**, dll). Nama symbol bisa beda tiap broker.

---

## 📋 TAHAP 4: Deploy Account ke MetaAPI

1. Balik ke **https://app.metaapi.cloud**
2. Klik **"Add account"** atau **"MetaTrader accounts → + New account"**
3. Isi form:
   - **Name**: bebas, misal `XAUUSD Bot`
   - **Type**: pilih **MetaTrader 5** (atau MT4 kalau broker lo MT4)
   - **Login**: masukkan login dari Tahap 3
   - **Password**: masukkan password dari Tahap 3
   - **Server**: masukkan server name dari Tahap 3
     - Untuk MetaQuotes demo: `MetaQuotes-Demo`
     - Untuk broker lain: lihat dari MT5 (klik kanan account → Properties)
   - **Region**: pilih **Singapore** atau **Tokyo** (paling dekat Indonesia, latency rendah)
   - **Magic**: kosongkan saja
   - **CopyFactory roles**: kosongkan (kita gak pake copy trading)
   - **Tags**: kosongkan
4. Klik **"Start"** atau **"Deploy"**
5. Tunggu beberapa menit sampai status jadi **"DEPLOYED"** ✅
   - Cek di **"MetaTrader accounts"** → status badge harus **hijau / DEPLOYED**
   - Kalau **"DEPLOYING"** tunggu dulu
   - Kalau **"DEPLOYMENT FAILED"** → cek login/password/server, ulangi

---

## 📋 TAHAP 5: Ambil Account ID

1. Di MetaAPI Dashboard, klik **"MetaTrader accounts"** (menu kiri)
2. Lihat daftar account lo, klik **"..."** atau **"View"** di sebelah account yang sudah deployed
3. **COPY ACCOUNT ID** — format UUID:
   ```
   12345678-1234-1234-1234-123456789abc
   ```
4. Atau di URL, ID ada di akhir: `https://app.metaapi.cloud/accounts/{ACCOUNT_ID}`

---

## 📋 TAHAP 6: Set di Railway Variables

1. Buka **https://railway.app/dashboard**
2. Pilih project **fortunate-amazement** (atau project bot lo)
3. Klik service **worker** (yang jalanin bot lo)
4. Klik tab **"Variables"**
5. Klik **"+ New Variable"**, tambahkan 2 var ini:

   | Variable Name | Value |
   |---|---|
   | `METAAPI_TOKEN` | paste token dari Tahap 2 |
   | `METAAPI_ACCOUNT_ID` | paste account ID dari Tahap 5 |

6. Klik **"Add"** untuk masing-masing
7. **Railway akan auto-redeploy** dalam beberapa menit

---

## 📋 TAHAP 7: Verifikasi

1. Cek log Railway setelah deploy:
   - **Status**: "📡 MetaAPI: ON" ← artinya variable ke-set dengan benar
   - **Error**: "METAAPI_TOKEN atau METAAPI_ACCOUNT_ID belum di-set" ← variable belum masuk
   - **Error**: "MetaAPI account belum DEPLOYED" ← deploy belum selesai, tunggu
   - **Error**: "404 / tidak ada data" ← symbol broker beda, perlu di-mapping

2. Test di Telegram:
   ```
   /start
   /status        ← harus show "MetaAPI: ✅"
   /signal        ← harus jalan
   ```

---

## 🆘 TROUBLESHOOTING

### ❌ "METAAPI_TOKEN atau METAAPI_ACCOUNT_ID belum di-set"
→ Cek Variables di Railway. Pastikan **kedua** variable sudah di-set dan di-save.

### ❌ "MetaAPI account belum DEPLOYED (state: ...)"
→ Tunggu deploy selesai. Kalau gagal, ulangi Tahap 4 dengan login/password yang benar.

### ❌ "Tidak ada data XAUUSD 1h"
→ Symbol di broker lo mungkin beda. Cek di MT5:
- Klik kanan **Symbols** → **Search** → ketik "XAU" atau "GOLD"
- Lihat nama persis (misal `XAUUSDm`, `XAUUSD.r`, `GoldCash`, `GOLD`, dll)

**Fix**: kasih tau saya nama symbol di broker lo, saya tambahkan ke `SYMBOL_MAP` di `candles.js`.

### ❌ "401 Unauthorized"
→ Token salah atau expired. Generate token baru (Ulangi Tahap 2).

### ❌ "Region: latency tinggi"
→ Coba ganti region ke **Singapore** atau **Hong Kong** (lebih dekat ke Indonesia).

---

## 💡 TIPS

- **Free tier aman** untuk 1 bot. Kalau lebih dari 1 bot / produksi, upgrade ke **Standard plan** ($10/bulan)
- **Backup account**: deploy 2 account (demo + real) untuk fail-safe
- **Symbol broker**: tiap broker beda. Cek dulu symbol XAU/USD di MT5 broker lo
- **Cek credit usage**: Dashboard MetaAPI → "Credit usage" untuk monitor penggunaan

---

## 📞 KASIH SAYA

Setelah selesai Tahap 6, kasih saya:
1. **METAAPI_TOKEN** (string panjang)
2. **METAAPI_ACCOUNT_ID** (UUID)

Saya akan set di Railway Variables, redeploy, dan verify bot hidup.

Atau kalau ada error, kasih **error message** dari log Railway supaya saya bisa bantu debug.
