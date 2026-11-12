import { assert, describe, test } from 'orca/testing'
import * as markers from './markers'
import { extractRun, readyInfo } from './markers'

const N = 'n1n1n1n1'
const m = (kind: string, id: string, rest = '') => `__CTR_${kind}_${id}__${rest ? ` ${rest}` : ''}`

describe('readyInfo', () => {
  // The ssh script's READY line carries the run nonce and only the kernel.
  test('reads the kernel from an ssh run READY line', () => {
    assert.deepEqual(readyInfo(['__CTR_READY_n1n1n1n1__ Linux', '__CTR_BEGIN_n1n1n1n1__ 1'], N), { kernel: 'Linux' })
    assert.deepEqual(readyInfo(['__CTR_READY_n1n1n1n1__ Darwin\r'], N), { kernel: 'Darwin' })
    assert.equal(readyInfo(['__CTR_READY_n2n2n2n2__ Linux'], N), null)
    assert.equal(readyInfo(['__CTR_READY_n1n1n1n1__'], N), null)
    assert.equal(readyInfo(['__CTR_READY_n1n1n1n1__   '], N), null)
  })
})

test('the session state and prompt reading are gone', () => {
  for (const name of ['sessionState', 'PROMPT_RE']) assert.equal(name in markers, false, name)
})

describe('extractRun', () => {
  test('a run whose BEGIN scrolled away is truncated', () => {
    const r = extractRun([m('SEC', N, 'ps'), 'row', m('RC', N, 'ps 0'), m('END', N, '2')], N)
    assert.equal(r.complete, true)
    assert.equal(r.truncated, true)
    assert.deepEqual(r.results, [{ name: 'ps', code: 0, lines: ['row'] }])
  })
  test('uses the last END and its own BEGIN only', () => {
    const lines = [
      m('BEGIN', N, '1'), m('SEC', N, 'ps'), 'old', m('RC', N, 'ps 0'), m('END', N, '2'),
      m('BEGIN', 'n2n2n2n2', '3'), m('SEC', 'n2n2n2n2', 'ps'), 'other', m('RC', 'n2n2n2n2', 'ps 0'), m('END', 'n2n2n2n2', '4'),
      m('BEGIN', N, '5'), m('SEC', N, 'ps'), 'new', m('SEC', 'n2n2n2n2', 'x'), m('RC', N, 'ps 3'), m('END', N, '6'),
    ]
    const r = extractRun(lines, N)
    assert.equal(r.truncated, false)
    assert.deepEqual(r.results, [{ name: 'ps', code: 3, lines: ['new'] }])
  })
  test('incomplete without END', () => {
    assert.deepEqual(extractRun([m('BEGIN', N, '1'), m('SEC', N, 'ps')], N), { complete: false, truncated: false, results: [] })
  })
  test('strips carriage returns and keeps output glued before a marker', () => {
    const r = extractRun([m('BEGIN', N, '1') + '\r', m('SEC', N, 'ps') + '\r', 'a\r', 'tail' + m('RC', N, 'ps 0') + '\r', m('END', N, '2') + '\r'], N)
    assert.deepEqual(r.results, [{ name: 'ps', code: 0, lines: ['a', 'tail'] }])
  })
})
