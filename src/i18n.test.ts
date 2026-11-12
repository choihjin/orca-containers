import { assert, test } from 'orca/testing'
import { messages, resolveLang } from './i18n'

test('resolveLang: en and ko force a language; anything else follows the Orca locale', () => {
  const table: [unknown, string, 'en' | 'ko'][] = [
    ['en', 'ko-KR', 'en'],
    ['en', 'ko', 'en'],
    ['ko', 'en-US', 'ko'],
    ['ko', 'en', 'ko'],
    ['auto', 'ko', 'ko'],
    ['auto', 'ko-KR', 'ko'],
    ['auto', 'KO-kr', 'ko'],
    ['auto', 'ko_KR', 'ko'],
    ['auto', 'en-US', 'en'],
    ['auto', 'en', 'en'],
    ['auto', 'ja-JP', 'en'],
    ['auto', '', 'en'],
    // Konkani: its code starts with the letters "ko", but it is not Korean.
    ['auto', 'kok-IN', 'en'],
    [undefined, 'ko-KR', 'ko'],
    [undefined, 'en-US', 'en'],
    [null, 'ko', 'ko'],
    // Unknown values are read as auto: the enum is exact, so case and other languages do not count.
    ['KO', 'en-US', 'en'],
    ['EN', 'ko-KR', 'ko'],
    ['fr', 'ko-KR', 'ko'],
    ['fr', 'en-US', 'en'],
    [42, 'ko', 'ko'],
    [{ lang: 'en' }, 'ko', 'ko'],
  ]
  for (const [setting, locale, expected] of table) {
    assert.equal(resolveLang(setting, locale), expected, `${JSON.stringify(setting)} ${locale}`)
  }
})

type Leaf = { path: string; value: unknown }
function leaves(value: unknown, path = ''): Leaf[] {
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => leaves(child, path === '' ? key : `${path}.${key}`))
  }
  return [{ path, value }]
}
const at = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined), root)
// Distinct values for each argument, so an output that drops or swaps one shows.
const ARGS = ['ARG0', 'ARG1', 'ARG2']

test('the ko catalog has a non-empty value for every en key, and no key en lacks', () => {
  const en = leaves(messages.en)
  const ko = leaves(messages.ko)
  assert.ok(en.length > 50, String(en.length))
  assert.deepEqual(ko.map((l) => l.path).sort(), en.map((l) => l.path).sort())
  for (const { path, value } of en) {
    const translated = at(messages.ko, path)
    assert.equal(typeof translated, typeof value, path)
    if (typeof value === 'string') {
      assert.ok(value.trim() !== '', `en ${path}`)
      assert.ok(typeof translated === 'string' && translated.trim() !== '', `ko ${path}`)
      continue
    }
    assert.equal(typeof value, 'function', path)
    const enFn = value as (...args: unknown[]) => unknown
    const koFn = translated as (...args: unknown[]) => unknown
    assert.equal(koFn.length, enFn.length, `arity of ${path}`)
    const args = ARGS.slice(0, enFn.length)
    for (const [lang, fn] of [['en', enFn], ['ko', koFn]] as const) {
      const out = fn(...args)
      assert.equal(typeof out, 'string', `${lang} ${path}`)
      // Every value the caller passes shows in the text.
      for (const arg of args) assert.ok(String(out).includes(arg), `${lang} ${path}: ${String(out)}`)
    }
  }
})

// Product words Koreans use as they are, and the short id label.
const SAME_IN_BOTH = ['ssh', 'shell', 'pull', 'fields.compose', 'fields.id']

test('every ko string differs from its en string, except the product words kept in English', () => {
  const kept: string[] = []
  for (const { path, value } of leaves(messages.en)) {
    if (typeof value !== 'string') continue
    if (at(messages.ko, path) === value) kept.push(path)
  }
  assert.deepEqual(kept.sort(), [...SAME_IN_BOTH].sort())
  for (const path of SAME_IN_BOTH) assert.equal(typeof at(messages.en, path), 'string', path)
})

test('the en counts use the right plural', () => {
  assert.equal(messages.en.tags(1), '1 tag')
  assert.equal(messages.en.tags(2), '2 tags')
  assert.equal(messages.en.tags(0), '0 tags')
  assert.equal(messages.en.runningOfTotal(1, 2), '1 running / 2')
  assert.equal(messages.en.composeRunning(1, 2), 'compose · 1/2 running')
  assert.equal(messages.ko.tags(1), '태그 1개')
  assert.equal(messages.ko.runningOfTotal(1, 2), '2개 중 1개 실행 중')
})
