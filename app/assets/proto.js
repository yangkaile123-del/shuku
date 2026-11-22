/* proto.js — 番茄小说 App reading 协议（浏览器/WebView 版）
 * 算法来源: hesan1232/fanqie.koplugin + huaerxiela/douyin-algorithm
 * 依赖: 无（MD5/AES/SM3/Simon 全部纯 JS；gzip 用 pako）
 */
var FQ = (function () {
  'use strict';
  var M64 = (1n << 64n) - 1n;

  /* ---------------- 字节工具 ---------------- */
  function alloc(n) { return new Uint8Array(n); }
  function u8From(a) { return a instanceof Uint8Array ? a : new Uint8Array(a); }
  function strToU8(s) { return new TextEncoder().encode(s); }
  function u8ToStr(u) { return new TextDecoder('utf-8', { fatal: false }).decode(u); }
  function concat(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }
  function hex(u) { var s = '', i; for (i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16); return s; }
  function unhex(h) {
    h = String(h).replace(/[^0-9a-fA-F]/g, '');
    var out = new Uint8Array(h.length >> 1), i;
    for (i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64e(u) {
    var s = '', i;
    for (i = 0; i < u.length; i += 3) {
      var b0 = u[i], b1 = u[i + 1], b2 = u[i + 2];
      s += B64C[b0 >> 2];
      s += B64C[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
      s += i + 1 < u.length ? B64C[((b1 & 15) << 2) | ((b2 || 0) >> 6)] : '=';
      s += i + 2 < u.length ? B64C[b2 & 63] : '=';
    }
    return s;
  }
  function b64d(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    var total = Math.floor(s.length * 3 / 4);
    var padded = s;
    while (padded.length % 4) padded += 'A';
    var out = new Uint8Array(total), o = 0, i;
    for (i = 0; i < padded.length; i += 4) {
      var n = (B64C.indexOf(padded[i]) << 18) | (B64C.indexOf(padded[i + 1]) << 12) |
        (B64C.indexOf(padded[i + 2]) << 6) | B64C.indexOf(padded[i + 3]);
      if (o < total) out[o++] = (n >> 16) & 255;
      if (o < total) out[o++] = (n >> 8) & 255;
      if (o < total) out[o++] = n & 255;
    }
    return out;
  }

  function pkcs7Pad(data, block) {
    block = block || 16;
    var n = block - (data.length % block);
    var p = new Uint8Array(n); p.fill(n);
    return concat([data, p]);
  }
  function pkcs7Unpad(data, block) {
    block = block || 16;
    if (!data.length || data.length % block) throw new Error('pkcs7 length');
    var n = data[data.length - 1];
    if (n < 1 || n > block) throw new Error('pkcs7 padding');
    return data.subarray(0, data.length - n);
  }

  function le64FromDecimal(s) {
    var digits = String(s).replace(/^0+/, '') || '0';
    var out = new Uint8Array(8), i;
    for (i = 0; i < 8; i++) {
      if (digits === '0') { out[i] = 0; continue; }
      var q = '', rem = 0, k;
      for (k = 0; k < digits.length; k++) {
        var cur = rem * 10 + (digits.charCodeAt(k) - 48);
        var d = Math.floor(cur / 256);
        rem = cur - d * 256;
        if (q.length > 0 || d > 0) q += String(d);
      }
      out[i] = rem;
      digits = q === '' ? '0' : q;
    }
    return out;
  }

  /* ---------------- MD5 ---------------- */
  var MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  var MD5_K = (function () {
    var k = new Uint32Array(64);
    for (var i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    return k;
  })();
  function md5(bytes) {
    var len = bytes.length, bitLen = len * 8;
    var padLen = (((len + 1 + 8) + 63) >> 6) << 6;
    var msg = new Uint8Array(padLen);
    msg.set(bytes); msg[len] = 0x80;
    var lo = bitLen >>> 0, hi = Math.floor(bitLen / 4294967296) >>> 0;
    msg[padLen - 8] = lo & 255; msg[padLen - 7] = (lo >>> 8) & 255; msg[padLen - 6] = (lo >>> 16) & 255; msg[padLen - 5] = (lo >>> 24) & 255;
    msg[padLen - 4] = hi & 255; msg[padLen - 3] = (hi >>> 8) & 255; msg[padLen - 2] = (hi >>> 16) & 255; msg[padLen - 1] = (hi >>> 24) & 255;
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var M = new Uint32Array(16);
    for (var off = 0; off < padLen; off += 64) {
      for (var i = 0; i < 16; i++) {
        var j = off + i * 4;
        M[i] = (msg[j] | (msg[j + 1] << 8) | (msg[j + 2] << 16) | (msg[j + 3] << 24)) >>> 0;
      }
      var A = a0, B = b0, C = c0, D = d0;
      for (var t = 0; t < 64; t++) {
        var F, g;
        if (t < 16) { F = (B & C) | (~B & D); g = t; }
        else if (t < 32) { F = (D & B) | (~D & C); g = (5 * t + 1) % 16; }
        else if (t < 48) { F = B ^ C ^ D; g = (3 * t + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * t) % 16; }
        F = (F + A + MD5_K[t] + M[g]) >>> 0;
        var sh = MD5_S[t];
        A = D; D = C; C = B;
        B = (B + (((F << sh) | (F >>> (32 - sh))) >>> 0)) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var out = new Uint8Array(16), w = [a0, b0, c0, d0];
    for (var q = 0; q < 4; q++) {
      out[q * 4] = w[q] & 255; out[q * 4 + 1] = (w[q] >>> 8) & 255;
      out[q * 4 + 2] = (w[q] >>> 16) & 255; out[q * 4 + 3] = (w[q] >>> 24) & 255;
    }
    return out;
  }

  /* ---------------- AES (128/192/256 CBC) ---------------- */
  var SBOX = new Uint8Array(256), INV_SBOX = new Uint8Array(256);
  (function () {
    var exp = new Uint8Array(512), log = new Uint8Array(256);
    var x = 1, i;
    for (i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x ^= (x << 1) ^ ((x & 0x80) ? 0x11b : 0); x &= 0xff; }
    for (i = 255; i < 512; i++) exp[i] = exp[i - 255];
    function rot8(b, n) { return ((b << n) | (b >>> (8 - n))) & 0xff; }
    for (i = 0; i < 256; i++) {
      var inv = i === 0 ? 0 : exp[255 - log[i]];
      var s = (inv ^ rot8(inv, 1) ^ rot8(inv, 2) ^ rot8(inv, 3) ^ rot8(inv, 4) ^ 0x63) & 0xff;
      SBOX[i] = s;
      INV_SBOX[s] = i;
    }
  })();

  function xt(a) { a <<= 1; return (a & 0x100) ? (a ^ 0x11b) & 0xff : a & 0xff; }
  function mul(a, b) {
    var r = 0;
    while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; }
    return r & 0xff;
  }

  function aesExpandKey(key) {
    var Nk = key.length >> 2, Nr = Nk + 6;
    var w = new Uint8Array(16 * (Nr + 1));
    w.set(key);
    var rcon = 1, i, temp = new Uint8Array(4);
    for (i = Nk; i < 4 * (Nr + 1); i++) {
      var off = (i - 1) * 4;
      temp[0] = w[off]; temp[1] = w[off + 1]; temp[2] = w[off + 2]; temp[3] = w[off + 3];
      if (i % Nk === 0) {
        var t0 = temp[0];
        temp[0] = SBOX[temp[1]] ^ rcon; temp[1] = SBOX[temp[2]]; temp[2] = SBOX[temp[3]]; temp[3] = SBOX[t0];
        rcon = xt(rcon);
      } else if (Nk > 6 && i % Nk === 4) {
        temp[0] = SBOX[temp[0]]; temp[1] = SBOX[temp[1]]; temp[2] = SBOX[temp[2]]; temp[3] = SBOX[temp[3]];
      }
      var po = (i - Nk) * 4;
      w[i * 4] = w[po] ^ temp[0];
      w[i * 4 + 1] = w[po + 1] ^ temp[1];
      w[i * 4 + 2] = w[po + 2] ^ temp[2];
      w[i * 4 + 3] = w[po + 3] ^ temp[3];
    }
    return { w: w, Nr: Nr };
  }

  function aesEncryptBlock(block, ks) {
    var st = new Uint8Array(16), w = ks.w, Nr = ks.Nr, r, i;
    for (i = 0; i < 16; i++) st[i] = block[i] ^ w[i];
    for (r = 1; r <= Nr; r++) {
      var t = new Uint8Array(16);
      for (i = 0; i < 16; i++) t[i] = SBOX[st[i]];
      // ShiftRows (state column-major: st[r + 4c])
      var s2 = new Uint8Array(16);
      for (var c = 0; c < 4; c++) for (var rr = 0; rr < 4; rr++) s2[rr + 4 * c] = t[rr + 4 * ((c + rr) % 4)];
      // MixColumns
      if (r !== Nr) {
        for (c = 0; c < 4; c++) {
          var a0 = s2[4 * c], a1 = s2[4 * c + 1], a2 = s2[4 * c + 2], a3 = s2[4 * c + 3];
          st[4 * c] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
          st[4 * c + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
          st[4 * c + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
          st[4 * c + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
        }
      } else st.set(s2);
      var koff = r * 16;
      for (i = 0; i < 16; i++) st[i] ^= w[koff + i];
    }
    return st;
  }

  function aesDecryptBlock(block, ks) {
    var w = ks.w, Nr = ks.Nr, i, r;
    var st = new Uint8Array(16);
    for (i = 0; i < 16; i++) st[i] = block[i] ^ w[Nr * 16 + i];
    for (r = Nr - 1; r >= 0; r--) {
      // InvShiftRows
      var s2 = new Uint8Array(16);
      for (var c = 0; c < 4; c++) for (var rr = 0; rr < 4; rr++) s2[rr + 4 * ((c + rr) % 4)] = st[rr + 4 * c];
      var t = new Uint8Array(16);
      for (i = 0; i < 16; i++) t[i] = INV_SBOX[s2[i]];
      var koff = r * 16;
      for (i = 0; i < 16; i++) t[i] ^= w[koff + i];
      if (r !== 0) {
        for (c = 0; c < 4; c++) {
          var a0 = t[4 * c], a1 = t[4 * c + 1], a2 = t[4 * c + 2], a3 = t[4 * c + 3];
          st[4 * c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
          st[4 * c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
          st[4 * c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
          st[4 * c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
        }
      } else st.set(t);
    }
    return st;
  }

  function aesCbcEncrypt(data, key, iv, pad) {
    var ks = aesExpandKey(key);
    var d = pad === false ? data : pkcs7Pad(data, 16);
    var out = new Uint8Array(d.length), prev = iv;
    for (var i = 0; i < d.length; i += 16) {
      var blk = new Uint8Array(16);
      for (var j = 0; j < 16; j++) blk[j] = d[i + j] ^ prev[j];
      var enc = aesEncryptBlock(blk, ks);
      out.set(enc, i);
      prev = enc;
    }
    return out;
  }
  function aesCbcDecrypt(data, key, iv, unpad) {
    var ks = aesExpandKey(key);
    if (data.length % 16) throw new Error('cipher len');
    var out = new Uint8Array(data.length), prev = iv;
    for (var i = 0; i < data.length; i += 16) {
      var dec = aesDecryptBlock(data.subarray(i, i + 16), ks);
      for (var j = 0; j < 16; j++) out[i + j] = dec[j] ^ prev[j];
      prev = data.subarray(i, i + 16);
    }
    return unpad === false ? out : pkcs7Unpad(out);
  }

  /* ---------------- SM3 ---------------- */
  var SM3_IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];
  function rotl32(x, n) { n %= 32; return n === 0 ? (x >>> 0) : (((x << n) | (x >>> (32 - n))) >>> 0); }
  function ff(j, x, y, z) { return j <= 15 ? (x ^ y ^ z) >>> 0 : ((x & y) | (x & z) | (y & z)) >>> 0; }
  function gg(j, x, y, z) { return j <= 15 ? (x ^ y ^ z) >>> 0 : ((x & y) | (~x & z)) >>> 0; }
  function p0(x) { return (x ^ rotl32(x, 9) ^ rotl32(x, 17)) >>> 0; }
  function p1(x) { return (x ^ rotl32(x, 15) ^ rotl32(x, 23)) >>> 0; }

  function sm3(msg) {
    msg = u8From(msg);
    var bitlen = BigInt(msg.length) * 8n;
    var m = concat([msg, new Uint8Array([0x80])]);
    while (m.length % 64 !== 56) m = concat([m, new Uint8Array([0])]);
    var lenb = new Uint8Array(8);
    for (var i = 0; i < 8; i++) lenb[i] = Number((bitlen >> BigInt(56 - i * 8)) & 0xffn);
    m = concat([m, lenb]);
    var V = SM3_IV.slice();
    var W = new Array(68), W1 = new Array(64);
    for (var off = 0; off < m.length; off += 64) {
      for (var i2 = 0; i2 < 16; i2++) {
        var o = off + i2 * 4;
        W[i2] = ((m[o] << 24) | (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3]) >>> 0;
      }
      for (var j = 16; j < 68; j++) {
        W[j] = (p1((W[j - 16] ^ W[j - 9] ^ rotl32(W[j - 3], 15)) >>> 0) ^ rotl32(W[j - 13], 7) ^ W[j - 6]) >>> 0;
      }
      for (j = 0; j < 64; j++) W1[j] = (W[j] ^ W[j + 4]) >>> 0;
      var a = V[0], b = V[1], c = V[2], d = V[3], e = V[4], f = V[5], g = V[6], h = V[7];
      for (j = 0; j < 64; j++) {
        var tj = j <= 15 ? 0x79cc4519 : 0x7a879d8a;
        var ss1 = rotl32((rotl32(a, 12) + e + rotl32(tj, j)) >>> 0, 7);
        var ss2 = (ss1 ^ rotl32(a, 12)) >>> 0;
        var tt1 = (ff(j, a, b, c) + d + ss2 + W1[j]) >>> 0;
        var tt2 = (gg(j, e, f, g) + h + ss1 + W[j]) >>> 0;
        d = c; c = rotl32(b, 9); b = a; a = tt1;
        h = g; g = rotl32(f, 19); f = e; e = p0(tt2);
      }
      V[0] = (V[0] ^ a) >>> 0; V[1] = (V[1] ^ b) >>> 0; V[2] = (V[2] ^ c) >>> 0; V[3] = (V[3] ^ d) >>> 0;
      V[4] = (V[4] ^ e) >>> 0; V[5] = (V[5] ^ f) >>> 0; V[6] = (V[6] ^ g) >>> 0; V[7] = (V[7] ^ h) >>> 0;
    }
    var out = new Uint8Array(32);
    for (var q = 0; q < 8; q++) {
      out[q * 4] = (V[q] >>> 24) & 255; out[q * 4 + 1] = (V[q] >>> 16) & 255;
      out[q * 4 + 2] = (V[q] >>> 8) & 255; out[q * 4 + 3] = V[q] & 255;
    }
    return out;
  }

  /* ---------------- 64 位 ---------------- */
  function ror64(v, n) { n = ((n % 64) + 64) % 64; v &= M64; if (!n) return v; var N = BigInt(n); return ((v >> N) | (v << (64n - N))) & M64; }
  function rol64(v, n) { n = ((n % 64) + 64) % 64; v &= M64; if (!n) return v; var N = BigInt(n); return ((v << N) | (v >> (64n - N))) & M64; }
  function leToU64(b, o) { o = o || 0; var v = 0n; for (var i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; }
  function u64ToLe(v) { v &= M64; var b = new Uint8Array(8); for (var i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; }

  /* ---------------- Ladon / Helios ---------------- */
  var AID = 1967n, LADON_AID = 3019n, LICENSE_ID = 1611921764n;
  function buildLadonHashTable(md5hex) {
    var buf = new Uint8Array(288);
    for (var z = 0; z < md5hex.length; z++) buf[z] = md5hex.charCodeAt(z) & 0xff;
    var t0 = leToU64(buf, 0), t1 = leToU64(buf, 8), t2 = leToU64(buf, 16), t3 = leToU64(buf, 24);
    var b0 = t0, b8 = t1, queue = [t2, t3];
    for (var i = 0n; i <= 0x21n; i++) {
      var x9 = b0;
      var x8 = ror64(b8, 8);
      x8 = (x8 + x9) & M64;
      x8 ^= i;
      queue.push(x8);
      x8 = x8 ^ ror64(x9, 61);
      buf.set(u64ToLe(x8), Number(i + 1n) * 8);
      b0 = x8; b8 = queue.shift();
    }
    return buf;
  }
  function encryptLadonBlock(table, block, off) {
    var d0 = leToU64(block, off), d1 = leToU64(block, off + 8);
    for (var i = 0; i <= 0x21; i++) {
      var h = leToU64(table, i * 8);
      d1 = (h ^ ((d0 + ror64(d1, 8)) & M64)) & M64;
      d0 = (d1 ^ ror64(d0, 61)) & M64;
    }
    return concat([u64ToLe(d0), u64ToLe(d1)]);
  }
  function randBytes(n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
  function encryptLadon(khronos) {
    var data = strToU8(khronos + '-' + LICENSE_ID + '-' + LADON_AID);
    var r4 = randBytes(4);
    var keygen = concat([r4, strToU8('1967')]);
    var md5hex = hex(md5(keygen));
    var table = buildLadonHashTable(md5hex);
    var padded = pkcs7Pad(data, 16), parts = [];
    for (var i = 0; i < padded.length; i += 16) parts.push(encryptLadonBlock(table, padded, i));
    return b64e(concat([r4, concat(parts)]));
  }

  /* ---------------- Argus (Simon 64/128) ---------------- */
  var SIGN_KEY = unhex('ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c');
  var INNER_SALT = new Uint8Array([0xf2, 0x81, 0x61, 0x6f]);
  var SIMON_Z = 0x3DC94C3A046D678Bn;

  function deriveInnerKey() { return sm3(concat([SIGN_KEY, INNER_SALT, SIGN_KEY])); }
  function simonKeyExpansion(key32) {
    var k = [], i;
    for (i = 0; i < 4; i++) k.push(leToU64(key32, i * 8));
    for (i = 4; i < 72; i++) {
      var tmp = ror64(k[i - 1], 3) ^ k[i - 3];
      tmp = tmp ^ ror64(tmp, 1);
      var bit = (SIMON_Z >> BigInt((i - 4) % 62)) & 1n;
      k[i] = ((~k[i - 4]) & M64) ^ tmp ^ bit ^ 3n;
    }
    return k;
  }
  function simonEncryptBlock(block, off, rks) {
    var x = leToU64(block, off), y = leToU64(block, off + 8);
    for (var i = 0; i < 72; i++) {
      var tmp = y;
      var f = rol64(y, 1) & rol64(y, 8);
      y = (x ^ f ^ rol64(y, 2) ^ rks[i]) & M64;
      x = tmp;
    }
    return concat([u64ToLe(x), u64ToLe(y)]);
  }
  function simonEncrypt(data, key32) {
    var rks = simonKeyExpansion(key32), parts = [];
    for (var i = 0; i < data.length; i += 16) parts.push(simonEncryptBlock(data, i, rks));
    return concat(parts);
  }
  function encryptEncPb(data, length) {
    var d = new Uint8Array(data.subarray(0, length));
    for (var i = 8; i < length; i++) d[i] = d[i] ^ d[i % 8];
    return d.reverse();
  }
  function pbVarint(v) {
    v = BigInt(v) & 0xffffffffn;
    var out = [];
    while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
    out.push(Number(v));
    return new Uint8Array(out);
  }
  function pbField(idx, wire, payload) { return concat([pbVarint((BigInt(idx) << 3n) | BigInt(wire)), payload]); }
  function pbVarintField(idx, val) { return pbField(idx, 0, pbVarint(val)); }
  function pbBytes(idx, data) { return pbField(idx, 2, concat([pbVarint(data.length), u8From(data)])); }
  function pbStr(idx, s) { return pbBytes(idx, strToU8(String(s))); }
  function u32shl(v, n) { var x = BigInt(v) & 0xffffffffn; return (x << BigInt(n)) & 0xffffffffn; }

  function encryptArgus(query, timestamp, deviceId, opts) {
    opts = opts || {};
    var versionName = opts.version_name || '7.3.7.33';
    var aid = opts.aid || AID;
    var deviceType = opts.device_type || 'P30';
    var osVersion = opts.os_version || '12';
    var randVal = opts.rand_val;
    if (randVal === undefined) randVal = BigInt('0x' + hex(randBytes(4))) & 0x7fffffffn;
    var bodyStubRaw = opts.body_stub ? unhex(opts.body_stub) : new Uint8Array(16);
    var bodyhash = sm3(bodyStubRaw.subarray(0, 16)).subarray(0, 6);
    var queryhash = (query && query !== '') ? sm3(strToU8(query)).subarray(0, 6) : sm3(new Uint8Array(16)).subarray(0, 6);

    var pb = concat([
      pbVarintField(1, u32shl(0x20200929, 1)),
      pbVarintField(2, 2),
      pbVarintField(3, randVal),
      pbStr(4, String(aid)),
      pbStr(5, String(deviceId)),
      pbStr(6, String(LICENSE_ID)),
      pbStr(7, versionName),
      pbStr(8, 'v04.04.05-ov-android'),
      pbVarintField(9, 134744640),
      pbBytes(10, new Uint8Array(8)),
      pbVarintField(11, 0),
      pbVarintField(12, u32shl(timestamp, 1)),
      pbBytes(13, bodyhash),
      pbBytes(14, queryhash),
      pbVarintField(20, 738),
      pbBytes(23, concat([
        pbStr(1, deviceType), pbStr(2, osVersion), pbStr(3, 'googleplay'), pbVarintField(4, 0x48000000)
      ]))
    ]);

    var simonKey = deriveInnerKey();
    var encPb = simonEncrypt(pkcs7Pad(pb, 16), simonKey);
    var prefix = new Uint8Array([0xf2, 0xf7, 0xfc, 0xff, 0xf2, 0xf7, 0xfc, 0xff]);
    var inner = encryptEncPb(concat([prefix, encPb]), encPb.length + 8);
    var head = new Uint8Array([0xa6, 0x6e, 0xad, 0x9f, 0x77, 0x01, 0xd0, 0x0c, 0x18]);
    var buf = concat([head, inner, strToU8('ao')]);
    var encrypted = aesCbcEncrypt(buf, md5(SIGN_KEY.subarray(0, 16)), md5(SIGN_KEY.subarray(16, 32)), true);
    return b64e(concat([new Uint8Array([0xf2, 0x81]), encrypted]));
  }

  function signHeaders(queryString, deviceId, opts) {
    opts = opts || {};
    var khronos = opts.khronos || Math.floor(Date.now() / 1000);
    return {
      'X-Khronos': String(khronos),
      'X-Ladon': encryptLadon(khronos),
      'X-Helios': encryptLadon(khronos),
      'X-Argus': encryptArgus(queryString, khronos, deviceId, opts)
    };
  }

  /* ---------------- 常量 / 查询串 ---------------- */
  var HOST = 'api5-normal-sinfonlinec.fqnovel.com';
  var REGISTERKEY_PATH = '/reading/crypt/registerkey';
  var BATCH_FULL_PATH = '/reading/reader/batch_full/v';
  var HARDCODED_KEY = unhex('ac25c67ddd8f38c1b37a2348828e222e');
  var WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  var BOOK_DETAIL_PATH = '/reading/bookapi/detail/v';

  function urlEncode(v) {
    return encodeURIComponent(String(v)).replace(/[!'()*]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }
  var QUERY_ORDER = ['iid', 'device_id', 'ac', 'channel', 'aid', 'app_name', 'version_code',
    'version_name', 'device_platform', 'os', 'ssmix', 'device_type', 'device_brand',
    'language', 'os_api', 'os_version', 'manifest_version_code', 'resolution',
    'dpi', 'update_version_code', '_rticket', 'host_abi', 'cdid', 'openudid',
    'item_ids', 'key_register_ts', 'book_id', 'req_type'];

  function encodeQuery(params) {
    var seen = {}, parts = [];
    function add(k, v) {
      if (v === undefined || v === null || seen[k]) return;
      seen[k] = 1;
      var ev = k === 'item_ids' ? urlEncode(v).replace(/%2C/gi, ',')
        : urlEncode(v).replace(/%2A/gi, '*').replace(/%2B/gi, '+');
      parts.push(urlEncode(k) + '=' + ev);
    }
    QUERY_ORDER.forEach(function (k) { if (params[k] !== undefined && params[k] !== null) add(k, params[k]); });
    Object.keys(params).forEach(function (k) { add(k, params[k]); });
    return parts.join('&');
  }

  function buildCommonQuery(device, tsMs) {
    return {
      iid: String(device.install_id), device_id: String(device.device_id), ac: 'wifi',
      channel: device.channel || '43536163a', aid: '1967', app_name: 'novelapp',
      version_code: String(device.version_code || '73733'),
      version_name: String(device.version_name || '7.3.7.33'),
      device_platform: 'android', os: 'android', ssmix: 'a',
      device_type: device.device_type || 'P30', device_brand: device.device_brand || 'HUAWEI',
      language: device.language || 'zh', os_api: String(device.os_api || '31'),
      os_version: String(device.os_version || '12'),
      manifest_version_code: String(device.version_code || '73733'),
      resolution: device.resolution || '1280*720', dpi: String(device.dpi || '240'),
      update_version_code: String(device.version_code || '73733'),
      _rticket: String(tsMs), host_abi: device.host_abi || 'arm64-v8a',
      cdid: device.cdid || '', openudid: device.openudid || ''
    };
  }
  function buildBatchFullQuery(device, bookId, itemIds, tsMs) {
    var q = buildCommonQuery(device, tsMs);
    q.item_ids = itemIds.join(',');
    q.key_register_ts = '0';
    q.book_id = String(bookId);
    q.req_type = '1';
    return q;
  }
  function buildUnsignedHeaders(device, tsMs) {
    var vc = device.version_code || '73733';
    var rom = String(device.rom_version || 'S643.217451.03386707').split('+')[0];
    var ua = 'com.dragon.read.oversea.gp/' + vc + ' (Linux; U; Android ' + (device.os_version || '12') +
      '; zh_CN; ' + (device.device_type || 'P30') + '; Build/' + rom + ';tt-ok/3.12.13.4-tiktok)';
    return {
      'User-Agent': ua,
      'Accept': 'application/json; charset=utf-8,application/x-protobuf',
      'Accept-Encoding': 'identity', 'sdk-version': '2', 'passport-sdk-version': '50564',
      'lc': '101', 'x-tt-store-region': 'cn-zj', 'x-tt-store-region-src': 'did',
      'x-vc-bdturing-sdk-version': '3.7.2.cn', 'x-xs-from-web': '0',
      'X-Ss-Req-Ticket': String(tsMs),
      'x-reading-request': tsMs + '-' + hex(randBytes(4)),
      'Cookie': 'store-region=cn-zj; store-region-src=did; install_id=' + device.install_id
    };
  }

  /* ---------------- 设备注册 ---------------- */
  var PROFILE = {
    channel: '43536163a', version_code: '73733', version_name: '7.3.7.33',
    device_type: 'P30', device_brand: 'HUAWEI', language: 'zh', os_api: '31',
    os_version: '12', resolution: '1280*720', dpi: '240', host_abi: 'arm64-v8a',
    rom_version: 'S643.217451.03386707'
  };
  function uuid4() {
    var b = randBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = hex(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function newProfile() {
    var p = {};
    Object.keys(PROFILE).forEach(function (k) { p[k] = PROFILE[k]; });
    p.cdid = uuid4(); p.openudid = hex(randBytes(8)); p.clientudid = uuid4();
    return p;
  }
  function quoteBigintIds(text) {
    ['device_id', 'install_id'].forEach(function (key) {
      text = text.replace(new RegExp('("' + key + '"\\s*:\\s*)(\\d{16,})', 'g'), '$1"$2"');
    });
    return text;
  }

  var NET = null, STORE = null;
  function init(cfg) { NET = cfg.net; STORE = cfg.store; }

  function http(method, url, headers, body) {
    return NET({ method: method, url: url, headers: headers || {}, body: body || null });
  }

  function deviceRegister() {
    var p = newProfile(), now = Date.now();
    var qs = ['ac=wifi', 'channel=' + p.channel, 'aid=1967', 'app_name=novelapp',
      'version_code=' + p.version_code, 'version_name=' + p.version_name, 'device_platform=android',
      'ssmix=a', 'device_type=' + p.device_type, 'device_brand=' + p.device_brand,
      'language=' + p.language, 'os_api=' + p.os_api, 'os_version=' + p.os_version,
      'openudid=' + p.openudid, 'manifest_version_code=' + p.version_code,
      'resolution=' + p.resolution, 'dpi=' + p.dpi, 'update_version_code=' + p.version_code,
      '_rticket=' + now, 'cdid=' + p.cdid].join('&');
    var header = {
      display_name: '番茄小说', update_version_code: Number(p.version_code),
      manifest_version_code: Number(p.version_code), aid: 1967, channel: p.channel,
      package: 'com.dragon.read', app_version: p.version_name, version_code: Number(p.version_code),
      sdk_version: '3.7.2.cn', os: 'Android', os_version: p.os_version, os_api: Number(p.os_api),
      device_model: p.device_type, device_brand: p.device_brand, device_manufacturer: p.device_brand,
      cpu_abi: p.host_abi, density_dpi: Number(p.dpi), resolution: p.resolution.replace('*', 'x'),
      language: p.language, timezone: 8, access: 'wifi', not_request_sender: 0,
      rom_version: p.rom_version, cdid: p.cdid, openudid: p.openudid, clientudid: p.clientudid,
      region: 'CN', tz_name: 'Asia/Shanghai', tz_offset: 28800, sim_region: 'cn',
      req_id: uuid4(), apk_first_install_time: now - 86400000, is_system_app: 0, sdk_flavor: 'china'
    };
    var body = JSON.stringify({ magic_tag: 'ss_app_log', header: header, _gen_time: now });
    var ua = 'com.dragon.read/' + p.version_code + ' (Linux; U; Android ' + p.os_version + '; zh_CN; ' +
      p.device_type + '; Build/' + p.rom_version + ';tt-ok/3.12.13.4-tiktok)';
    return http('POST', 'https://log.snssdk.com/service/2/device_register/?' + qs, {
      'Content-Type': 'application/json; charset=utf-8', 'User-Agent': ua, 'Accept-Encoding': 'identity'
    }, body).then(function (r) {
      var text = u8ToStr(r.body);
      if (r.status < 200 || r.status >= 300) throw new Error('device_register HTTP ' + r.status);
      var data = JSON.parse(quoteBigintIds(text));
      var device_id = String(data.device_id_str || data.device_id || '');
      var install_id = String(data.install_id_str || data.install_id || '');
      if (!device_id || !install_id) throw new Error('注册未返回 device_id');
      p.device_id = device_id; p.install_id = install_id;
      return p;
    });
  }

  function ensureDevice() {
    var cached = STORE.get('fq_device');
    if (cached && cached.device_id && cached.install_id) return Promise.resolve(cached);
    return deviceRegister().then(function (d) { STORE.set('fq_device', d); return d; });
  }

  function signedCall(device, path, buildQuery, buildBody) {
    var tsMs = Date.now();
    var qs = encodeQuery(buildQuery(device, tsMs));
    var body = buildBody ? buildBody(device) : null;
    var headers = buildUnsignedHeaders(device, tsMs);
    if (body) headers['Content-Type'] = 'application/json';
    var sig = signHeaders(qs, device.device_id, {
      khronos: Math.floor(tsMs / 1000), version_name: device.version_name,
      device_type: device.device_type, os_version: device.os_version
    });
    Object.keys(sig).forEach(function (k) { headers[k] = sig[k]; });
    headers['X-Ss-Req-Ticket'] = String(tsMs);
    var url = 'https://' + HOST + path + '?' + qs;
    return http(body ? 'POST' : 'GET', url, headers, body).then(function (r) {
      var text = u8ToStr(r.body);
      if (r.status < 200 || r.status >= 300) throw new Error(path + ' HTTP ' + r.status);
      var data;
      try { data = JSON.parse(text); } catch (e) { throw new Error(path + ' 非 JSON'); }
      if (Number(data.code) !== 0) throw new Error(path + ' code=' + data.code + ' ' + (data.message || ''));
      return data;
    });
  }

  function buildRegisterContent(deviceId, userId) {
    var payload = concat([le64FromDecimal(deviceId), le64FromDecimal(userId || 0)]);
    var iv = randBytes(16);
    return b64e(concat([iv, aesCbcEncrypt(payload, HARDCODED_KEY, iv, true)]));
  }
  function decryptServerKey(b64) {
    var raw = b64d(b64);
    if (raw.length < 17) throw new Error('key too short');
    var pt = aesCbcDecrypt(raw.subarray(16), HARDCODED_KEY, raw.subarray(0, 16), true);
    return hex(pt).toUpperCase();
  }
  function registerKey(device) {
    return signedCall(device, REGISTERKEY_PATH,
      function (d, ts) { return buildCommonQuery(d, ts); },
      function (d) { return JSON.stringify({ content: buildRegisterContent(d.device_id, 0), keyver: 1 }); }
    ).then(function (data) {
      if (!data.data || !data.data.key) throw new Error('registerkey 无 key');
      return decryptServerKey(data.data.key);
    });
  }
  function getV1Key(device, force) {
    if (!force) {
      var c = STORE.get('fq_v1key');
      if (c && c.key && c.device_id === device.device_id && Date.now() - (c.ts || 0) < 7 * 86400000) return Promise.resolve(c.key);
    }
    return registerKey(device).then(function (key) {
      STORE.set('fq_v1key', { key: key, device_id: device.device_id, ts: Date.now() });
      return key;
    });
  }

  /* ---------------- 解压 / 正文 ---------------- */
  function maybeDecompress(data, compressStatus) {
    if (!data || !data.length) return data;
    var isGzip = data[0] === 0x1f && data[1] === 0x8b;
    var isZlib = data[0] === 0x78;
    if (!(Number(compressStatus || 0) > 0 || isGzip || isZlib)) return data;
    var tries = [];
    if (isGzip) tries = ['gzip', 'zlib', 'raw'];
    else if (isZlib) tries = ['zlib', 'gzip', 'raw'];
    else tries = ['raw', 'zlib', 'gzip'];
    for (var i = 0; i < tries.length; i++) {
      try {
        if (tries[i] === 'gzip') return pako.ungzip(data);
        if (tries[i] === 'zlib') return pako.inflate(data);
        return pako.inflateRaw(data);
      } catch (e) { /* next */ }
    }
    return data;
  }

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', middot: '·' };
  function unescapeHtml(s) {
    return s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(Number(d)); })
      .replace(/&([a-zA-Z]+);/g, function (m, n) { return ENT[n] !== undefined ? ENT[n] : m; });
  }
  function extractText(xhtml) {
    if (!xhtml) return '';
    var s = xhtml;
    s = s.replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, '\n');
    s = s.replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '\n');
    s = s.replace(/<blk[^>]*>/gi, '').replace(/<\/blk>/gi, '');
    s = s.replace(/<[^>]*>/g, '');
    s = unescapeHtml(s);
    return s.split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim(); })
      .filter(function (l) { return l.length > 0; }).join('\n');
  }

  function decodeChapterItem(item, v1Key) {
    var contentStr = item.content || item.origin_content || '';
    if (contentStr === '' || contentStr === 'Invalid') return '';
    var cryptStatus = Number(item.crypt_status || 0);
    var compressStatus = Number(item.compress_status || 0);
    var raw;
    if (cryptStatus === 0 && v1Key) {
      var b = b64d(contentStr);
      if (b.length < 17) throw new Error('密文过短');
      raw = aesCbcDecrypt(b.subarray(16), unhex(v1Key.toLowerCase()), b.subarray(0, 16), true);
    } else {
      raw = strToU8(contentStr);
    }
    return u8ToStr(maybeDecompress(raw, compressStatus));
  }

  function batchFull(device, bookId, itemIds, v1Key) {
    return signedCall(device, BATCH_FULL_PATH,
      function (d, ts) { return buildBatchFullQuery(d, bookId, itemIds, ts); }, null
    ).then(function (data) {
      var out = {};
      itemIds.forEach(function (id) {
        var it = data.data[String(id)];
        if (Array.isArray(it)) it = it[0];
        if (!it) return;
        try {
          out[id] = { title: it.title, text: extractText(decodeChapterItem(it, v1Key)) };
        } catch (e) { out[id] = null; }
      });
      return out;
    });
  }


  /* ---------------- 书籍元数据（/page 的 __INITIAL_STATE__.page，免签） ---------------- */
  function parsePageState(h) {
    var k = 'window.__INITIAL_STATE__=';
    var s = h.indexOf(k);
    if (s < 0) return null;
    s += k.length;
    var d = 0, end = -1;
    for (var i = s; i < h.length; i++) {
      var c = h[i];
      if (c === '{') d++;
      else if (c === '}') { d--; if (d === 0) { end = i + 1; break; } }
    }
    if (end < 0) return null;
    try { return JSON.parse(h.slice(s, end)); } catch (e) { return null; }
  }

  function bookMeta(bookId) {
    return http('GET', 'https://fanqienovel.com/page/' + bookId, { 'User-Agent': WEB_UA }, null).then(function (r) {
      var st = parsePageState(u8ToStr(r.body));
      var p = (st && st.page) || null;
      if (!p) return null;
      var cats = [];
      try {
        var arr = JSON.parse(p.categoryV2 || '[]');
        for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].Name) cats.push(arr[i].Name);
      } catch (e) { }
      return {
        id: String(bookId),
        name: p.bookName || '',
        author: p.author || p.authorName || '',
        categories: cats,
        finished: String(p.creationStatus) === '0',
        words: Number(p.wordNumber || 0),
        chapters: Number(p.chapterTotal || 0),
        abstract: p.abstract || '',
        cover: coverUrl(p.thumbUri || p.thumbUrl)
      };
    });
  }


  /* ---------------- 封面：HEIC → 可直接显示的 JPEG/PNG ----------------
   * 番茄给 App 的 thumb_url 全是 .heic（HEVC 静图），WebView/Chrome 解不了。
   * 但同一张图在 p3-novel.byteimg.com 上可以按 tplv 模板重取成 jpeg/png，且不需要签名。
   * 规则：/<host>/novel-pic/<HASH>~tplv-任何.heic?query  →  p3-novel.byteimg.com/novel-pic/<HASH>~tplv-resize:225:300.image
   * 例外：/novel-pic-r/<HASH> 这条路径改写会 403，只能返回空（前端走渐变占位）。
   */
  function coverUrl(raw) {
    var u = String(raw || '');
    if (!u) return '';
    // 1) 正常封面：novel-pic/<hash>  → 换成 resize 模板的 image（jpeg/png）
    var m = u.match(/\/novel-pic\/([^~?\/]+)/);
    if (m) return 'https://p3-novel.byteimg.com/novel-pic/' + m[1] + '~tplv-resize:225:300.image';
    // 2) 音频封面兜底：novel-static/<hash>（novel-pic-r 的书只能走这条）
    m = u.match(/^(https?):\/\/([^\/]+)\/(?:origin\/)?novel-static\/([^~?\/]+)/);
    if (m) return m[1] + '://' + m[2] + '/novel-static/' + m[3] + '~tplv-tt-cs0:300:300.image';
    return '';
  }
  function coverOf(book) {
    var keys = ['thumb_url', 'detail_page_thumb_url', 'expand_thumb_url', 'audio_thumb_uri', 'audio_thumb_url_hd'];
    for (var i = 0; i < keys.length; i++) {
      var c = coverUrl(book && book[keys[i]]);
      if (c) return c;
    }
    return '';
  }

  /* ---------------- 网页接口（免签） ---------------- */
  function webGet(url) {
    return http('GET', url, { 'User-Agent': WEB_UA, 'Accept': 'application/json' }, null)
      .then(function (r) { return JSON.parse(u8ToStr(r.body)); });
  }

  function directory(bookId) {
    return webGet('https://fanqienovel.com/api/reader/directory/detail?bookId=' + bookId)
      .then(function (j) {
        var list = [];
        var vols = (j.data && j.data.chapterListWithVolume) || [];
        vols.forEach(function (v) { v.forEach(function (c) { list.push(c); }); });
        return { raw: j.data, chapters: list };
      });
  }

  function search(keyword, page) {
    return ensureDevice().then(function (d) {
      return signedCall(d, '/reading/bookapi/search/page/v', function (dev, ts) {
        var q = buildCommonQuery(dev, ts);
        q.query = keyword; q.page_count = '10'; q.page_index = String(page || 0); q.search_type = '1';
        return q;
      }, null);
    }).then(function (data) {
      var cells = data.data || data.cell_list || [];
      var books = [];
      cells.forEach(function (cell) {
        (cell.book_data || []).forEach(function (b) {
          books.push({
            id: String(b.book_id), name: b.book_name, author: b.author,
            abstract: b.abstract || '', category: b.category || '',
            finished: String(b.creation_status) === '0',
            words: Number(b.word_number || 0),
            cover: coverOf(b)
          });
        });
      });
      return books;
    });
  }

  function rank(gender, type) {
    var url = 'https://fanqienovel.com/rank/' + (gender || 1) + '_' + (type || 1);
    return http('GET', url, { 'User-Agent': WEB_UA }, null).then(function (r) {
      var h = u8ToStr(r.body);
      var key = 'window.__INITIAL_STATE__=';
      var s = h.indexOf(key);
      if (s < 0) return [];
      var st = s + key.length, d = 0, end = -1;
      for (var i = st; i < h.length; i++) {
        if (h[i] === '{') d++;
        else if (h[i] === '}') { d--; if (d === 0) { end = i + 1; break; } }
      }
      var j = JSON.parse(h.slice(st, end));
      var bl = (j.rank && j.rank.book_list) || [];
      return bl.map(function (b, idx) {
        return { id: String(b.bookId), name: b.bookName || '', author: b.author || '', pos: idx + 1, cover: coverUrl(b.thumbUri) };
      });
    });
  }

  function bookDetail(bookId) {
    return ensureDevice().then(function (d) {
      return signedCall(d, BOOK_DETAIL_PATH, function (dev, ts) {
        var q = buildCommonQuery(dev, ts);
        q.book_id = String(bookId);
        return q;
      }, null);
    }).then(function (data) {
      var b = data.data || {};
      var ai = b.author_info || {};
      return {
        id: String(bookId),
        name: b.book_name || '',
        author: ai.user_name || '',
        abstract: b.abstract || '',
        category: b.category || '',
        words: Number(b.word_number || 0),
        chapters: Number(b.serial_count || b.estimated_chapter_count || 0),
        finished: String(b.status) === '1' || String(b.status) === '0',
        readInfo: b.sub_info || '',
        score: b.score || '',
        cover: coverOf(b),
        tags: (function () { try { return JSON.parse(b.category_schema || '[]').map(function (x) { return x.name; }).slice(0, 4); } catch (e) { return []; } })()
      };
    });
  }

  function bookTitle(bookId) {
    return http('GET', 'https://fanqienovel.com/page/' + bookId, { 'User-Agent': WEB_UA }, null).then(function (r) {
      var h = u8ToStr(r.body);
      var m = h.match(/<title>([^<]*)<\/title>/);
      if (!m) return '';
      return m[1].split('完整版在线免费阅读')[0].split('小说_')[0].trim();
    });
  }

  return {
    init: init, ensureDevice: ensureDevice, getV1Key: getV1Key, signedCall: signedCall,
    batchFull: batchFull, directory: directory, search: search, rank: rank, bookDetail: bookDetail, bookTitle: bookTitle,
    bookMeta: bookMeta, parsePageState: parsePageState,
    coverOf: coverOf, coverUrl: coverUrl,
    buildCommonQuery: buildCommonQuery, extractText: extractText, decodeChapterItem: decodeChapterItem,
    maybeDecompress: maybeDecompress,
    _test: { md5: md5, aesCbcEncrypt: aesCbcEncrypt, aesCbcDecrypt: aesCbcDecrypt, sm3: sm3, b64e: b64e, b64d: b64d, hex: hex, unhex: unhex }
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = FQ;
