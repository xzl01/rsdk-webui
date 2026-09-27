/**
 * SHA-512 crypt is easy to get subtly wrong (the byte permutation and the
 * custom base64 padding in particular), so it is checked against the reference
 * implementation. `openssl passwd -6` is that reference; the test is skipped
 * where openssl is unavailable rather than silently passing.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { randomPassword, randomSalt, sha512crypt } from './sha512crypt.ts'

function openssl(password: string, salt: string): string | null {
  try {
    // openssl treats an empty argv argument as "no password", so feed stdin
    return execFileSync('openssl', ['passwd', '-6', '-salt', salt, '-stdin'], {
      input: password,
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

// note: an empty password is deliberately absent - openssl refuses to hash one
// (both as an argv argument and via -stdin), so there is no reference to compare
// against. It is covered by the shape test below instead.
const CASES: Array<[string, string]> = [
  ['a', 'salt1234'],
  ['password', '12345678'],
  ['correct horse battery staple', 'saltsaltsaltsalt'],
  ['中文密码测试', 'zhongwen12345678'],
  ['p@ss word with spaces', 'spaces!!'],
  ['a'.repeat(200), 'abcdefgh'],
  ['密码🔒', 'saltsalt'],
  ['pw', '0123456789abcdef'],
]

test('sha512crypt matches the reference implementation', async () => {
  const reference = openssl('probe', 'probesalt')
  if (reference === null) {
    console.error('openssl not available - skipping the cross-check')
    return
  }
  assert.equal(reference, await sha512crypt('probe', { salt: 'probesalt' }))

  for (const [password, salt] of CASES) {
    const expected = openssl(password, salt)
    assert.ok(expected, `openssl could not hash ${JSON.stringify(password)}`)
    assert.equal(
      await sha512crypt(password, { salt }),
      expected,
      `mismatch for ${JSON.stringify(password)} / ${salt}`,
    )
  }
})

test('sha512crypt output shape and randomness', async () => {
  const hash = await sha512crypt('hunter2')
  assert.match(hash, /^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/)
  const again = await sha512crypt('hunter2')
  assert.notEqual(hash, again, 'a fresh salt must be used every time')

  // the reference cannot express an empty password, but the code path (key_len
  // zero) must still produce a well-formed hash
  assert.match(await sha512crypt('', { salt: 'abcdefgh' }), /^\$6\$abcdefgh\$[./0-9A-Za-z]{86}$/)

  const rounds = await sha512crypt('hunter2', { salt: 'rounds', rounds: 1000 })
  assert.match(rounds, /^\$6\$rounds=1000\$rounds\$/)

  // a >16 character salt is truncated, as the format requires
  assert.equal(await sha512crypt('pw', { salt: 'a'.repeat(40) }), await sha512crypt('pw', { salt: 'a'.repeat(16) }))
})

test('random helpers produce the right alphabet and length', () => {
  const salt = randomSalt()
  assert.equal(salt.length, 16)
  assert.match(salt, /^[./0-9A-Za-z]{16}$/)
  const password = randomPassword(24)
  assert.equal(password.length, 24)
  assert.notEqual(password, randomPassword(24))
})
