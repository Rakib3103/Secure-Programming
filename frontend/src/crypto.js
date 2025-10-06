/* eslint-disable no-unused-vars */
import forge from 'node-forge';

/* ---------------- Base64URL helpers ---------------- */
function b64ToB64u(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64uToB64(b64u) {
  const pad = b64u.length % 4 ? '='.repeat(4 - (b64u.length % 4)) : '';
  return b64u.replace(/-/g, '+').replace(/_/g, '/') + pad;
}
function b64uEncode(bytes) {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return b64ToB64u(btoa(s));
}

function decode64Flexible(s) {
  const looksUrl = s.includes('-') || s.includes('_');
  const b64 = looksUrl
    ? s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
    : s;
  return forge.util.decode64(b64);
}

function b64uDecode(b64u) {
  const bin = atob(b64uToB64(b64u));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function utf8ToBytes(s) {
  return new TextEncoder().encode(s);
}
function bytesToUtf8(u8) {
  return new TextDecoder().decode(u8);
}

/* ---------------- PEM <-> base64url helpers ---------------- */
function pemB64uToPemText(pemB64u) {
  return bytesToUtf8(b64uDecode(pemB64u));
}
function pemTextToPemB64u(pemText) {
  return b64uEncode(utf8ToBytes(pemText));
}

/* ---------------- RSA key generation (PEM base64url like Python) ---------------- */
function derToPem(derBuf, label) {
  const u8 = derBuf instanceof ArrayBuffer ? new Uint8Array(derBuf) : new Uint8Array(derBuf.buffer || derBuf);
  const b64 = btoa(String.fromCharCode(...u8));
  const lines = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

// UTF-8 string -> base64url
function utf8ToB64u(str) {
  const bytes = new TextEncoder().encode(str);              // UTF-8 -> Uint8Array
  const b64  = btoa(String.fromCharCode(...bytes));         // -> base64
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); // -> base64url
}
export async function generateRsaKeypair() {
    if (window.crypto?.subtle) {
    const kp = await crypto.subtle.generateKey(
      { name:'RSA-OAEP', modulusLength:4096, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' },
      true,
      ['encrypt','decrypt']
    );
    const spki  = await crypto.subtle.exportKey('spki',  kp.publicKey);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const pubPem  = derToPem(spki,  'PUBLIC KEY');
    const privPem = derToPem(pkcs8, 'PRIVATE KEY');
    return {
      public_key_b64:  utf8ToB64u(pubPem),
      private_key_b64: utf8ToB64u(privPem),
    };
  }
  // Fallback forge nếu không có WebCrypto
  const kp = forge.pki.rsa.generateKeyPair({ bits: 4096, e: 0x10001 });
  const pkcs8 = forge.pki.privateKeyInfoToPem(
    forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(kp.privateKey))
  );
  const pubPem = forge.pki.publicKeyToPem(kp.publicKey);
  return { public_key_b64: utf8ToB64u(pubPem), private_key_b64: utf8ToB64u(pkcs8) };

}

export async function generateRsaSignKeypair() {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 4096, e: 0x10001 });
  const pkcs8 = forge.pki.privateKeyInfoToPem(
    forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(kp.privateKey)),
  );
  const pubPem = forge.pki.publicKeyToPem(kp.publicKey);
  return {
    private_key_b64: pemTextToPemB64u(pkcs8),
    public_key_b64: pemTextToPemB64u(pubPem),
  };
}

/* ---------------- Load keys from PEM base64url ---------------- */
export function loadPrivateKey(privPemB64u) {
  console.log({ privPemB64u });
  const pem = pemB64uToPemText(privPemB64u);
  // Accept PKCS8 or PKCS1
  try {
    return forge.pki.privateKeyFromPem(pem);
  } catch {
    // In case it's PKCS8 -> convert to privateKey
    const obj = forge.pki.privateKeyInfoFromPem(pem);
    return forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(obj.privateKey));
  }
}

function calcPssMaxSaltLenForge(
  pubKey /* forge.pki.rsa.PublicKey */,
  sha = 'sha256',
) {
  const hLen =
    sha.toLowerCase() === 'sha256'
      ? 32
      : sha.toLowerCase() === 'sha1'
        ? 20
        : sha.toLowerCase() === 'sha384'
          ? 48
          : sha.toLowerCase() === 'sha512'
            ? 64
            : (() => {
                throw new Error('Unsupported hash');
              })();

  const modBits = pubKey.n.bitLength(); // forge BigInteger
  const emLen = Math.ceil((modBits - 1) / 8);
  return emLen - hLen - 2; // PSS.MAX_LENGTH
}

export function loadPublicKey(pubPemB64u) {
  const pem = pemB64uToPemText(pubPemB64u);
  return forge.pki.publicKeyFromPem(pem);
}

/* ---------------- RSA-OAEP (SHA-256) ---------------- */
// export function rsaEncrypt(publicKey, plaintext) {
//   const bytes = typeof plaintext === 'string' ? forge.util.encodeUtf8(plaintext) : String.fromCharCode(...plaintext);
//   const ct = publicKey.encrypt(bytes, 'RSA-OAEP', {
//     md: forge.md.sha256.create(),
//     mgf1: forge.mgf.mgf1.create(forge.md.sha256.create()),
//   });
//   return b64ToB64u(forge.util.encode64(ct));
// }
// export function rsaDecrypt(privateKey, ciphertextB64u) {
//   const ctBytes = forge.util.decode64(b64uToB64(ciphertextB64u));
//   const pt = privateKey.decrypt(ctBytes, 'RSA-OAEP', {
//     md: forge.md.sha256.create(),
//     mgf1: forge.mgf.mgf1.create(forge.md.sha256.create()),
//   });
//   // return Uint8Array like previous API
//   const bin = forge.util.binary.raw.decode(pt);
//   const out = new Uint8Array(bin.length);
//   for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
//   return out;
// }

export function rsaEncrypt(publicKey, plaintext, opts = { hash: 'sha256' }) {
  const bytes =
    typeof plaintext === 'string'
      ? forge.util.encodeUtf8(plaintext)
      : String.fromCharCode(...plaintext);

  const useSha256 = (opts.hash || 'sha256').toLowerCase() === 'sha256';
  const md = useSha256 ? forge.md.sha256.create() : forge.md.sha1.create();
  const mgf = forge.mgf.mgf1.create(
    useSha256 ? forge.md.sha256.create() : forge.md.sha1.create(),
  );

  const ct = publicKey.encrypt(bytes, 'RSA-OAEP', { md, mgf1: mgf });
  return b64ToB64u(forge.util.encode64(ct));
}

export function rsaDecrypt(privateKey, ciphertextB64Any) {
  // ciphertextB64Any: base64 hoặc base64url -> binary string
  const ct = decode64Flexible(ciphertextB64Any);

  const tryDec = md =>
    privateKey.decrypt(ct, 'RSA-OAEP', {
      md,
      mgf1: forge.mgf.mgf1.create(md),
    });

  const attempts = [forge.md.sha256.create(), forge.md.sha1.create()];
  let lastErr;

  for (const md of attempts) {
    try {
      const pt = tryDec(md); // <- plaintext là BINARY STRING
      const out = new Uint8Array(pt.length);
      for (let i = 0; i < pt.length; i++) out[i] = pt.charCodeAt(i);
      return out; // trả bytes
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `RSA-OAEP decrypt failed (SHA-256, SHA-1): ${lastErr?.message || 'unknown'}`,
  );
}
/* ---------------- RSA-PSS (SHA-256, saltLength=32) ---------------- */
export function rsaSignPss(privateKey, data) {
  const md = forge.md.sha256.create();
  if (typeof data === 'string') md.update(data, 'utf8');
  else md.update(String.fromCharCode(...data), 'raw');

  const pss = forge.pss.create({
    md: forge.md.sha256.create(),
    mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
    saltLength: 32,
  });
  const sigBytes = privateKey.sign(md, pss);
  return b64ToB64u(forge.util.encode64(sigBytes));
}
export function rsaVerifyPss(publicKey, data, sigB64u) {
  const md = forge.md.sha256.create();
  if (typeof data === 'string') md.update(data, 'utf8');
  else md.update(String.fromCharCode(...data), 'raw');

  // const pss = forge.pss.create({
  //   md: forge.md.sha256.create(),
  //   mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
  //   saltLength: 32,
  // });
  const pss = forge.pss.create({
    md: forge.md.sha256.create(),
    mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
    // saltLength: calcPssMaxSaltLenForge(publicKey), // <-- MAX_LENGTH tương ứng
    saltLength: 32,
  });
  const sigBytes = forge.util.decode64(b64uToB64(sigB64u));
  return publicKey.verify(md.digest().bytes(), sigBytes, pss);
}

/* ---------------- Content sig helpers (like Python) ---------------- */
export function computeContentSig(privKey, ciphertextB64u, fromId, toId, ts) {
  const msg = `${ciphertextB64u}${fromId}${toId}${ts}`;
  return rsaSignPss(privKey, msg);
}
export function verifyContentSig(
  pubKey,
  ciphertextB64u,
  fromId,
  toId,
  ts,
  sigB64u,
) {
  const msg = `${ciphertextB64u}${fromId}${toId}${ts}`;
  return rsaVerifyPss(pubKey, msg, sigB64u);
}
export function computePublicContentSig(privKey, ciphertextB64u, fromId, ts) {
  const msg = `${ciphertextB64u}${fromId}${ts}`;
  return rsaSignPss(privKey, msg);
}
export function verifyPublicContentSig(
  pubKey,
  ciphertextB64u,
  fromId,
  ts,
  sigB64u,
) {
  const msg = `${ciphertextB64u}${fromId}${ts}`;
  return rsaVerifyPss(pubKey, msg, sigB64u);
}

/* ---------------- AES-GCM (iv(12) | tag(16) | ciphertext) ---------------- */
export function generateAesKey() {
  const bytes = forge.random.getBytesSync(32);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return out;
}
export function aesEncrypt(rawKey, plaintext) {
  const keyBytes = String.fromCharCode(...rawKey);
  const iv = forge.random.getBytesSync(12); // 96-bit nonce (recommended)
  const cipher = forge.cipher.createCipher('AES-GCM', keyBytes);
  const dataBytes =
    typeof plaintext === 'string'
      ? forge.util.encodeUtf8(plaintext)
      : String.fromCharCode(...plaintext);
  cipher.start({ iv, tagLength: 128 });
  cipher.update(forge.util.createBuffer(dataBytes));
  cipher.finish();
  const tag = cipher.mode.tag.getBytes(); // 16 bytes
  const body = cipher.output.getBytes();
  const combined = iv + tag + body;
  return b64ToB64u(forge.util.encode64(combined));
}
export function aesDecrypt(rawKey, ciphertextB64u) {
  const keyBytes = String.fromCharCode(...rawKey);
  const combined = forge.util.decode64(b64uToB64(ciphertextB64u));
  const iv = combined.substring(0, 12);
  const tag = combined.substring(12, 28);
  const body = combined.substring(28);
  const decipher = forge.cipher.createDecipher('AES-GCM', keyBytes);
  decipher.start({ iv, tagLength: 128, tag });
  decipher.update(forge.util.createBuffer(body));
  const ok = decipher.finish();
  if (!ok) throw new Error('AES-GCM auth failed');
  const pt = decipher.output.getBytes();
  return forge.util.decodeUtf8(pt);
}

/* ---------------- Misc ---------------- */
export function currentTimestamp() {
  return Date.now();
}
