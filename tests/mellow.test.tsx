import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SCENES, SceneRun } from '../hooks/scenes'
import { parseSource } from '../hooks/stations'

const PANE_PROPS = {
  title: 'mellow',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { top: 0, bodyRows: 30 },
  view: {},
}

/** The host beneath the plugin: no binaries, osascript answers, the rest in memory. */
function world(on: On, scripts: string[]) {
  mock.store(on)
  mock.env(on, { HOME: '/Users/test' })
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'osascript') {
      scripts.push(e.argv[2] ?? '')
      return { value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'missing', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  return clock
}

test('links become sources', () => {
  expect(parseSource('https://www.youtube.com/watch?v=rFZHOHl-L8A')).toEqual({ kind: 'youtube', id: 'rFZHOHl-L8A' })
  expect(parseSource('https://open.spotify.com/playlist/37i9dQZF1DWWQRwui0ExPn?si=x')).toEqual({
    kind: 'spotify',
    uri: 'spotify:playlist:37i9dQZF1DWWQRwui0ExPn',
  })
  expect(parseSource('https://radio.example/stream.mp3')).toEqual({ kind: 'stream', url: 'https://radio.example/stream.mp3' })
  expect(parseSource('hello')).toBe(null)
})

test('every scene paints a full raster', () => {
  for (const def of SCENES) {
    const run = new SceneRun(def, 40, 8)
    run.frame(0.1)
    const cells = run.frame(0.1)
    // 40 * 8 cells, three u32 each, base64 of 3840 bytes.
    expect(cells.length).toBe(5120)
  }
})

test('a Spotify link plays through the app and shows in the pane', async ($, on) => {
  const scripts: string[] = []
  world(on, scripts)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const added = await $.command.run({ command: 'mellow', args: 'add https://open.spotify.com/playlist/37i9dQZF1DWWQRwui0ExPn my mix' })
  expect(added.text).toBe('Added and playing my mix.')
  expect(scripts.some((s) => s.includes('play track "spotify:playlist:37i9dQZF1DWWQRwui0ExPn"'))).toBe(true)

  const list = await $.command.run({ command: 'mellow', args: 'list' })
  expect(list.text).toContain('▶ 17. my mix')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mellow', surface, component: 'Pane', requestId: 'mellow', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'my mix' })).toBeDefined()
    expect(await ui.find({ type: 'Raster', key: 'scene' })).toEqual(surface === 'terminal' ? expect.anything() : undefined)
    await ui.unmount()
  }
})

test('volume is clamped and persisted', async ($, on) => {
  world(on, [])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'mellow', args: 'vol 140' })).text).toBe('Volume 100%.')
  expect((await $.command.run({ command: 'mellow', args: 'vol' })).text).toBe('Volume is 100%.')
})
