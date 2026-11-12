import { assert, describe, test } from 'orca/testing'
import * as orcaCli from './orca-cli'
import { CliError, createOrcaCli, nodeExec } from './orca-cli'

function fake(replies: unknown[]) {
  const calls: string[][] = []
  const files: string[] = []
  const timeouts: number[] = []
  const exec = async (file: string, args: string[], options: { timeoutMs: number }) => {
    files.push(file)
    calls.push(args)
    timeouts.push(options.timeoutMs)
    const reply = replies.shift()
    return { stdout: typeof reply === 'string' ? reply : JSON.stringify(reply) }
  }
  return { calls, files, timeouts, exec }
}
const ok = (result: unknown) => ({ ok: true, result })

describe('orca cli client', () => {
  test('builds exact argv with --json', async () => {
    const f = fake([
      ok({ terminal: { handle: 'term_1' } }),
      ok({ worktrees: [], hostScope: { hostIds: ['local'], omittedHostIds: [] } })
    ])
    const cli = createOrcaCli('/bin/orca', f.exec)
    const handle = await cli.createTerminal({ environment: 'GPU1', worktreePath: '/w', title: 'shell: web', command: 'c', focus: true })
    assert.equal(handle, 'term_1')
    assert.deepEqual(f.calls[0], ['terminal', 'create', '--environment', 'GPU1', '--worktree', 'path:/w', '--title', 'shell: web', '--command', 'c', '--focus', '--json'])
    await cli.listWorktrees('GPU1')
    assert.deepEqual(f.calls[1], ['worktree', 'list', '--environment', 'GPU1', '--limit', '500', '--json'])
    assert.ok(f.files.every((x) => x === '/bin/orca'))
    assert.ok(f.timeouts.every((x) => x === 30_000))
  })

  // Listing, actions and logs on an SSH host go over ssh: the client keeps no way to type into, read or close a terminal.
  test('the client can no longer type into, read or close a terminal', () => {
    const cli = createOrcaCli('orca', fake([]).exec)
    for (const name of ['send', 'read', 'close']) assert.equal(name in cli, false, name)
    assert.equal('TRANSIENT_CODES' in orcaCli, false)
  })

  test('a terminal handle that is not term_ and 1-64 letters, digits or - is a bad reply', async () => {
    const create = (handle: unknown) => createOrcaCli('orca', fake([ok({ terminal: { handle } })]).exec)
      .createTerminal({ environment: 'E', worktreePath: '/w', title: 't', command: 'c' })
    const bad = ['bad', 'term_', 'term_a/b', 'term_a b', 'term_1;rm', `term_${'x'.repeat(65)}`, ' term_1', 'term_1\n']
    const codes = await Promise.all(bad.map((handle) => create(handle).then(() => 'accepted', (e: unknown) => e instanceof CliError ? e.code : 'other')))
    assert.deepEqual(Object.fromEntries(bad.map((handle, i) => [handle, codes[i]])), Object.fromEntries(bad.map((handle) => [handle, 'cli_bad_reply'])))
    for (const handle of ['term_1', 'term_Ab-9', `term_${'x'.repeat(64)}`]) assert.equal(await create(handle), handle)
  })

  test('switchTo builds argv with and without an environment and uses a 5 s timeout', async () => {
    const f = fake([ok({ navigated: true }), ok({ navigated: true })])
    const cli = createOrcaCli('orca', f.exec, 30_000)
    await cli.switchTo({ environment: 'GPU1', handle: 'term_1' })
    await cli.switchTo({ handle: 'term_2' })
    assert.deepEqual(f.calls[0], ['terminal', 'switch', '--environment', 'GPU1', '--terminal', 'term_1', '--json'])
    assert.deepEqual(f.calls[1], ['terminal', 'switch', '--terminal', 'term_2', '--json'])
    assert.deepEqual(f.timeouts, [5_000, 5_000])
  })

  test('create without focus omits --focus', async () => {
    const f = fake([ok({ terminal: { handle: 'term_2' } })])
    const cli = createOrcaCli('orca', f.exec, 5_000)
    await cli.createTerminal({ environment: 'E', worktreePath: '/w', title: 't', command: 'c' })
    assert.equal(f.calls[0]!.includes('--focus'), false)
    assert.deepEqual(f.timeouts, [5_000])
  })

  test('lists only ssh-tunnel environments', async () => {
    const f = fake([ok({ environments: [{ name: 'GPU1', connectionDependency: 'ssh-tunnel' }, { name: 'other', connectionDependency: 'none' }, { name: 'x' }] })])
    const cli = createOrcaCli('orca', f.exec)
    assert.deepEqual(await cli.listSshEnvironments(), ['GPU1'])
    assert.deepEqual(f.calls[0], ['environment', 'list', '--json'])
  })

  test('the host listings take a per-call timeout', async () => {
    const worktrees = ok({ worktrees: [], hostScope: { hostIds: ['local'], omittedHostIds: [] } })
    const f = fake([ok({ environments: [] }), worktrees, ok({ environments: [] }), worktrees])
    const cli = createOrcaCli('orca', f.exec, 30_000)
    await cli.listSshEnvironments({ timeoutMs: 10_000 })
    await cli.listWorktrees('GPU1', { timeoutMs: 7_000 })
    await cli.listSshEnvironments()
    await cli.listWorktrees('GPU1')
    assert.deepEqual(f.timeouts, [10_000, 7_000, 30_000, 30_000])
  })

  test('lists local terminals without --environment', async () => {
    const f = fake([ok({ terminals: [{ handle: 'term_1', worktreePath: '/w', title: 'x' }] })])
    const cli = createOrcaCli('orca', f.exec)
    assert.deepEqual(await cli.listLocalTerminals(), [{ handle: 'term_1', worktreePath: '/w' }])
    assert.deepEqual(f.calls[0], ['terminal', 'list', '--json'])
  })

  // Ruling R1: a hung terminal list must not hold a request for the client's 30 s default.
  test('the local terminal list takes a per-call timeout', async () => {
    const terminals = ok({ terminals: [] })
    const f = fake([terminals, terminals])
    const cli = createOrcaCli('orca', f.exec, 30_000)
    await cli.listLocalTerminals({ timeoutMs: 5_000 })
    await cli.listLocalTerminals()
    assert.deepEqual(f.timeouts, [5_000, 30_000])
  })

  test('maps worktree rows', async () => {
    const f = fake([ok({ worktrees: [{ id: 'i', path: '/w', displayName: 'main', branch: 'refs/heads/main' }], hostScope: { hostIds: ['local'], omittedHostIds: [] } })])
    const cli = createOrcaCli('orca', f.exec)
    assert.deepEqual(await cli.listWorktrees('GPU1'), [{ path: '/w', displayName: 'main', branch: 'refs/heads/main' }])
  })

  test('a worktree list that does not cover the host is unreachable', async () => {
    const f = fake([ok({ worktrees: [], hostScope: { hostIds: [], omittedHostIds: ['local'], omittedHostSelectors: ['x'] } })])
    const cli = createOrcaCli('orca', f.exec)
    await assert.rejects(cli.listWorktrees('cloud-gpu'), (e: unknown) => e instanceof CliError && e.code === 'host_not_covered')
  })

  test('turns an error reply into CliError with its code', async () => {
    const f = fake([{ ok: false, error: { code: 'remote_runtime_unavailable', message: 'Remote Orca runtime closed the connection.' } }])
    const cli = createOrcaCli('orca', f.exec)
    await assert.rejects(cli.listSshEnvironments(), (e: unknown) => {
      return e instanceof CliError && e.code === 'remote_runtime_unavailable' && e.message === 'Remote Orca runtime closed the connection.'
    })
  })

  test('an exec rejection with a string code keeps that code', async () => {
    const cli = createOrcaCli('orca', async () => { throw Object.assign(new Error('too slow'), { code: 'cli_timeout' }) })
    await assert.rejects(cli.listWorktrees('E'), (e: unknown) => e instanceof CliError && e.code === 'cli_timeout' && e.message === 'too slow')
  })

  test('non-JSON output is cli_not_json', async () => {
    const f = fake(['oops not json'])
    const cli = createOrcaCli('orca', f.exec)
    await assert.rejects(cli.listSshEnvironments(), (e: unknown) => e instanceof CliError && e.code === 'cli_not_json')
  })

  test('a reply without the expected result shape is cli_bad_reply', async () => {
    const f = fake([ok({})])
    const cli = createOrcaCli('orca', f.exec)
    await assert.rejects(cli.createTerminal({ environment: 'E', worktreePath: '/w', title: 't', command: 'c' }), (e: unknown) => e instanceof CliError && e.code === 'cli_bad_reply')
  })

  test('an exec failure becomes cli_exec_failed', async () => {
    const cli = createOrcaCli('orca', async () => { throw new Error('spawn ENOENT') })
    await assert.rejects(cli.listSshEnvironments(), (e: unknown) => e instanceof CliError && e.code === 'cli_exec_failed' && e.message.includes('ENOENT'))
  })

  describe('nodeExec (runs node itself only)', () => {
    const run = (script: string, timeoutMs = 5_000) => nodeExec()(process.execPath, ['-e', script], { timeoutMs })
    test('resolves with stdout when the process exits non-zero', async () => {
      const out = await run(`console.log('{"ok":false}'); process.exit(1)`)
      assert.equal(out.stdout.trim(), '{"ok":false}')
    })
    test('rejects when the process fails without output', async () => {
      await assert.rejects(run('process.exit(1)'))
    })
    test('a timeout rejects with cli_timeout even when partial stdout exists', async () => {
      await assert.rejects(run(`process.stdout.write('{"ok"'); setTimeout(() => {}, 10000)`, 200), (e: unknown) => (e as { code?: string }).code === 'cli_timeout')
    })
  })
})
