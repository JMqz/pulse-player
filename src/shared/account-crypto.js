// .rfacc account export format: "RFAC" | iv(12) | gcm tag(16) | AES-256-GCM(deflateRaw(json)).
// Shared by the Electron main process and the Pulse (Tauri) Node host.
const crypto = require('crypto');
const zlib = require('zlib');
const RFACC_KEY = crypto.createHash('sha256').update('riff-account-key-v1').digest();

function encryptAccount(dataObj) {
  const jsonStr = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
  const compressed = zlib.deflateRawSync(Buffer.from(jsonStr, 'utf8'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', RFACC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from('RFAC');
  return Buffer.concat([header, iv, tag, encrypted]);
}

function decryptAccount(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) throw new Error('Invalid account file');
  if (buffer.subarray(0, 4).toString('utf8') !== 'RFAC') throw new Error('Invalid file header');
  const iv = buffer.subarray(4, 16);
  const tag = buffer.subarray(16, 32);
  const encrypted = buffer.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', RFACC_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const decompressed = zlib.inflateRawSync(decrypted);
  return JSON.parse(decompressed.toString('utf8'));
}

module.exports = { encryptAccount, decryptAccount };
