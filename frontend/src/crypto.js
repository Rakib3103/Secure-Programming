const subtle = window.crypto.subtle;

// === Base64URL helpers ===
export function base64urlEncode(buf) {
  let str = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return str.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64urlDecode(b64url) {
  let pad = b64url.length % 4;
  if (pad) b64url += "=".repeat(4 - pad);
  const b64 = b64url.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// === RSA ===
export async function generateRsaKeypair() {
  const keyPair = await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );

  const spki = await subtle.exportKey("spki", keyPair.publicKey);
  const pkcs8 = await subtle.exportKey("pkcs8", keyPair.privateKey);
  return {
    private_key_b64: base64urlEncode(pkcs8),
    public_key_b64: base64urlEncode(spki)
  };
}

export async function loadPrivateKey(private_b64) {
  const buf = base64urlDecode(private_b64);
  return await subtle.importKey(
    "pkcs8",
    buf,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
}

export async function loadPublicKey(public_b64) {
  const buf = base64urlDecode(public_b64);
  return await subtle.importKey(
    "spki",
    buf,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"]
  );
}

export async function rsaEncrypt(publicKey, plaintext) {
  const enc = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const ciphertext = await subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    enc
  );
  return base64urlEncode(ciphertext);
}

export async function rsaDecrypt(privateKey, ciphertext_b64) {
  const buf = base64urlDecode(ciphertext_b64);
  const plaintext = await subtle.decrypt({ name: "RSA-OAEP" }, privateKey, buf);
  return new Uint8Array(plaintext);
}

// === RSA-PSS for signing/verification ===
export async function generateRsaSignKeypair() {
  const keyPair = await subtle.generateKey(
    {
      name: "RSASSA-PSS",
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const spki = await subtle.exportKey("spki", keyPair.publicKey);
  const pkcs8 = await subtle.exportKey("pkcs8", keyPair.privateKey);
  return {
    private_key_b64: base64urlEncode(pkcs8),
    public_key_b64: base64urlEncode(spki)
  };
}

export async function rsaSign(privateKey, data) {
  const enc = new TextEncoder().encode(data);
  const signature = await subtle.sign(
    { name: "RSASSA-PSS", saltLength: 32 },
    privateKey,
    enc
  );
  return base64urlEncode(signature);
}

export async function rsaVerify(publicKey, data, sig_b64) {
  const enc = new TextEncoder().encode(data);
  const sig = base64urlDecode(sig_b64);
  return await subtle.verify(
    { name: "RSASSA-PSS", saltLength: 32 },
    publicKey,
    sig,
    enc
  );
}

// === Payload canonicalization ===
export function canonicalizePayload(payload) {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

// === Combined signature helpers ===
export async function computeContentSig(privKey, ciphertext, fromId, to, ts) {
  const data = `${ciphertext}${fromId}${to}${ts}`;
  return await rsaSign(privKey, data);
}

export async function verifyContentSig(pubKey, ciphertext, fromId, to, ts, sig_b64) {
  const data = `${ciphertext}${fromId}${to}${ts}`;
  return await rsaVerify(pubKey, data, sig_b64);
}

export async function computePublicContentSig(privKey, ciphertext, fromId, ts) {
  const data = `${ciphertext}${fromId}${ts}`;
  return await rsaSign(privKey, data);
}

export async function verifyPublicContentSig(pubKey, ciphertext, fromId, ts, sig_b64) {
  const data = `${ciphertext}${fromId}${ts}`;
  return await rsaVerify(pubKey, data, sig_b64);
}

export async function computeTransportSig(privKey, payload) {
  const canonical = canonicalizePayload(payload);
  return await rsaSign(privKey, canonical);
}

export async function verifyTransportSig(pubKey, payload, sig_b64) {
  const canonical = canonicalizePayload(payload);
  return await rsaVerify(pubKey, canonical, sig_b64);
}

// === AES ===
export async function generateAesKey() {
  const key = await subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const raw = await subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

export async function aesEncrypt(rawKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const enc = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const cipherbuf = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const tagStart = cipherbuf.byteLength - 16;
  const tag = new Uint8Array(cipherbuf.slice(tagStart));
  const combined = new Uint8Array([...iv, ...tag, ...new Uint8Array(cipherbuf.slice(0, tagStart))]);
  return base64urlEncode(combined);
}

export async function aesDecrypt(rawKey, ciphertext_b64) {
  const combined = base64urlDecode(ciphertext_b64);
  const iv = combined.slice(0, 16);
  const tag = combined.slice(16, 32);
  const ciphertext = combined.slice(32);
  const key = await subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const cipherbuf = new Uint8Array([...ciphertext, ...tag]); // reconstruct GCM structure
  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, cipherbuf);
  return new TextDecoder().decode(plaintext);
}

// === Key share signature ===
export async function computeKeyShareSig(privKey, shares, creator_pub) {
  const canonical = JSON.stringify(shares.sort());
  const data = canonical + creator_pub;
  return await rsaSign(privKey, data);
}