/**
 * crypt(3) SHA-512, as used by /etc/shadow on every modern Linux.
 *
 * Implemented here (rather than shelling out to `openssl passwd -6` on the
 * server) for two reasons:
 *
 *   * the plaintext password never has to leave the browser - that is what the
 *     UI has been claiming all along, and
 *   * the backend-less (GitHub Pages) build has no server to ask.
 *
 * Web Crypto provides the SHA-512 primitive, so this is portable and testable:
 * `render.test.ts` checks the output against `openssl passwd -6`.
 *
 * Reference: "SHA-crypt" by Ulrich Drepper (the algorithm /etc/shadow uses),
 * including its custom base64 alphabet.
 */
const ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ROUNDS_DEFAULT = 5000
const encoder = new TextEncoder()

async function sha512(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const buffer = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    buffer.set(part, offset)
    offset += part.length
  }
  const digest = await crypto.subtle.digest('SHA-512', buffer)
  return new Uint8Array(digest)
}

/** repeat `source` cyclically to produce exactly `length` bytes */
function cycled(source: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = source[i % source.length]
  return out
}

/** the crypt base64 encoding: 3 bytes -> 4 characters, in a peculiar order */
function encode64(bytes: Uint8Array, count: number): string {
  let result = ''
  let offset = 0
  const remaining = () => count - offset
  while (remaining() > 0) {
    // the caller pads the final group, so all three bytes are always there -
    // the meaningful one sits in the *low* byte, which is why zero-padding here
    // (as this used to) silently dropped the last two characters
    const b0 = bytes[offset] ?? 0
    const b1 = bytes[offset + 1] ?? 0
    const b2 = bytes[offset + 2] ?? 0
    let value = (b0 << 16) | (b1 << 8) | b2
    const chars = 4
    for (let i = 0; i < chars; i++) {
      result += ALPHABET[value & 0x3f]
      value >>= 6
    }
    offset += 3
  }
  return result
}

export type Sha512CryptOptions = {
  /** 8..16 characters; generated when omitted */
  salt?: string
  rounds?: number
}

export async function sha512crypt(password: string, options: Sha512CryptOptions = {}): Promise<string> {
  const rounds = options.rounds ?? ROUNDS_DEFAULT
  const salt = (options.salt ?? randomSalt()).slice(0, 16)
  const pw = encoder.encode(password)
  const sa = encoder.encode(salt)

  // digest B = SHA512(password + salt + password), used as a byte source below
  const b = await sha512(pw, sa, pw)

  // digest A
  const aParts: Uint8Array[] = [pw, sa]
  for (let i = pw.length; i > 0; i -= 64) {
    aParts.push(b.subarray(0, Math.min(i, 64)))
  }
  for (let i = pw.length; i > 0; i >>= 1) {
    aParts.push(i & 1 ? b : pw)
  }
  const a = await sha512(...aParts)

  // DP: password repeated to its own length, then cycled
  const dpParts: Uint8Array[] = []
  for (let i = 0; i < pw.length; i++) dpParts.push(pw)
  const dp = cycled(await sha512(...dpParts), pw.length)

  // DS: salt repeated (16 + a[0]) times, then cycled
  const dsParts: Uint8Array[] = []
  for (let i = 0; i < 16 + a[0]; i++) dsParts.push(sa)
  const ds = cycled(await sha512(...dsParts), sa.length)

  // the expensive part
  let digest = a
  for (let round = 0; round < rounds; round++) {
    const parts: Uint8Array[] = []
    parts.push(round & 1 ? dp : digest)
    if (round % 3 !== 0) parts.push(ds)
    if (round % 7 !== 0) parts.push(dp)
    parts.push(round & 1 ? digest : dp)
    digest = await sha512(...parts)
  }

  // final permutation, in the order the specification dictates
  const order = [
    [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26],
    [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32],
    [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38],
    [18, 39, 60], [40, 61, 19], [62, 20, 41],
  ]
  // 21 groups of three bytes, then one lone byte: the reference emits four
  // characters per group but only *two* for the last one, so encode 22 groups
  // and keep the first 86 characters.
  const permuted: number[] = []
  for (const [high, mid, low] of order) permuted.push(digest[high], digest[mid], digest[low])
  permuted.push(0, 0, digest[63])
  const encoded = encode64(Uint8Array.from(permuted), 64).slice(0, 86)

  if (rounds === ROUNDS_DEFAULT) {
    return `$6$${salt}$${encoded}`
  }
  return `$6$rounds=${rounds}$${salt}$${encoded}`
}

export function randomSalt(length = 16): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => ALPHABET[byte % 64]).join('')
}

/** a memorable-enough random password for a first-boot account */
export function randomPassword(length = 18): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^&*-_=+'
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}
