import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { MellowNow, MellowStation, MellowTools, MellowView } from '../types'
import { Player, preparePicture, type Host } from './player'
import { SCENES, SceneRun } from './scenes'
import { STATIONS, kindLabel, parseSource } from './stations'

const PANE = 'mellow'
const ACCENT = '#ffb27a'
const FRAME_MS = 140

const nowAtom = atom({ plugin: 'mellow', key: 'now' } as const, { stationId: STATIONS[0]!.id, status: 'stopped' } as MellowNow)
const volumeAtom = atom({ plugin: 'mellow', key: 'volume' } as const, 60)
const sceneAtom = atom({ plugin: 'mellow', key: 'scene' } as const, 'rain')
const viewAtom = atom({ plugin: 'mellow', key: 'view' } as const, 'player' as MellowView)
const customAtom = atom({ plugin: 'mellow', key: 'custom' } as const, [] as MellowStation[])
const picturesAtom = atom({ plugin: 'mellow', key: 'pictures' } as const, [] as string[])
const toolsAtom = atom({ plugin: 'mellow', key: 'tools' } as const, { ffplay: false, ytdlp: false, spotify: false, checked: false } as MellowTools)

type Settings = { stationId?: string; volume?: number; scene?: string; custom?: MellowStation[]; pictures?: string[] }

/** Everything that acts, built in `session.start` as closures over that hook's `$`. */
type Controller = {
  stations: () => Promise<MellowStation[]>
  tune: (station: MellowStation) => Promise<string>
  togglePlay: () => Promise<string>
  step: (delta: 1 | -1) => Promise<string>
  skip: (delta: 1 | -1) => Promise<boolean>
  stop: () => Promise<void>
  setVolume: (value: number) => Promise<number>
  setScene: (id: string) => Promise<void>
  cycleScene: () => Promise<string>
  toggleView: (view: MellowView) => Promise<void>
  addStation: (station: MellowStation) => Promise<void>
  removeStation: (id: string) => Promise<void>
  addPicture: (path: string) => Promise<string | null>
  startTicker: () => void
  stopTicker: () => void
  dispose: () => Promise<void>
}

// Module state: rebuilt on a reload, which also ends any child process.
let ctl: Controller | null = null
let scene: SceneRun | null = null
const prepared = new Map<string, string>()

function sceneName(id: string, pictures: string[]): string {
  if (id === 'off') return 'no picture'
  if (id.startsWith('pic:')) return pictures[Number(id.slice(4))]?.split('/').pop() ?? 'picture'
  return SCENES.find((s) => s.id === id)?.name ?? id
}

function bar(volume: number, width: number): string {
  const filled = Math.round((volume / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const HELP = `mellow — lofi in your terminal
/mellow                    open the player pane
/mellow play [name|#]      play the current or a named station
/mellow pause | stop | next | prev
/mellow vol <0-100>        set the volume
/mellow scene [name]       switch the picture: rain, sunset, forest, aurora, off
/mellow add <link> [name]  add a YouTube, Spotify or radio stream link
/mellow remove <name>      remove a station you added
/mellow pic <path>         add your own picture (png, jpg, heic…)
/mellow list               list stations
In the pane (click it or ctrl+x tab): k play/pause · j/l prev/next · d/u volume · b picture · s stations · p pictures`

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mellow',
      description: 'Lofi radio: open the player, or play / pause / next / vol / scene / add',
      argumentHint: '[play|pause|next|prev|vol N|scene|add <link>|pic <path>|list]',
      immediate: true,
    })

    const host: Host = {
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
      storeGet: (key) => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      stat: (path) => $.fs.stat(path),
      log: (text) => $.ui.log(`mellow: ${text}`, { to: 'debug' }),
    }

    const stations = async () => [...STATIONS, ...(await read($, customAtom))]

    const player = new Player(host, async (patch) => {
      const now = await update($, nowAtom, (n) => ({ ...n, ...patch }))
      const st = (await stations()).find((s) => s.id === now.stationId)
      if (now.status === 'playing' && st) $.ui.status(`♪ ${now.track ? `${now.track.title} — ${now.track.artist}` : st.name}`)
      else if (now.status === 'loading' && st) $.ui.status(`♪ tuning in ${st.name}…`)
      else $.ui.status(undefined)
    })

    const persist = async () => {
      const settings: Settings = {
        stationId: (await read($, nowAtom)).stationId,
        volume: await read($, volumeAtom),
        scene: await read($, sceneAtom),
        custom: await read($, customAtom),
        pictures: await read($, picturesAtom),
      }
      await $.store.set('settings', settings)
    }

    const currentStation = async () => {
      const all = await stations()
      const { stationId } = await read($, nowAtom)
      return all.find((s) => s.id === stationId) ?? all[0]!
    }

    const tune = async (station: MellowStation) => {
      player.volume = await read($, volumeAtom)
      await update($, nowAtom, (n) => ({ ...n, stationId: station.id }))
      void persist()
      await player.play(station)
      return outcome(station)
    }

    const outcome = async (st: MellowStation) => {
      const now = await read($, nowAtom)
      return now.status === 'error' ? `${st.name}: ${now.message ?? 'could not play.'}` : `Playing ${st.name}.`
    }

    let ticker: Timer | null = null

    ctl = {
      stations,
      tune,
      async togglePlay() {
        const now = await read($, nowAtom)
        const st = await currentStation()
        if (now.status === 'playing' || now.status === 'loading') {
          await player.pause()
          return 'Paused.'
        }
        if (player.station?.id === st.id && now.status === 'paused') await player.resume()
        else await tune(st)
        return outcome(st)
      },
      async step(delta) {
        const all = await stations()
        const { stationId } = await read($, nowAtom)
        const i = all.findIndex((s) => s.id === stationId)
        const st = all[(i + delta + all.length) % all.length]!
        await tune(st)
        return outcome(st)
      },
      skip: (delta) => player.skip(delta),
      stop: () => player.stop(),
      async setVolume(value) {
        const v = Math.max(0, Math.min(100, Math.round(value)))
        await update($, volumeAtom, () => v)
        player.setVolume(v)
        void persist()
        return v
      },
      async setScene(id) {
        await update($, sceneAtom, () => id)
        void persist()
      },
      async cycleScene() {
        const pics = await read($, picturesAtom)
        const ids = [...SCENES.map((s) => s.id), ...pics.map((_, i) => `pic:${i}`), 'off']
        const cur = await read($, sceneAtom)
        const id = ids[(ids.indexOf(cur) + 1) % ids.length]!
        await update($, sceneAtom, () => id)
        void persist()
        return sceneName(id, pics)
      },
      async toggleView(view) {
        await update($, viewAtom, (v) => (v === view ? 'player' : view))
      },
      async addStation(station) {
        await update($, customAtom, (list) => [...list, station])
        await tune(station)
      },
      async removeStation(id) {
        await update($, customAtom, (list) => list.filter((s) => s.id !== id))
        void persist()
      },
      async addPicture(raw) {
        const home = (await $.env.get('HOME')) ?? ''
        const path = raw.replace(/^["']|["']$/g, '').replace(/^~(?=\/)/, home)
        try {
          await $.fs.stat(path)
        } catch {
          return null
        }
        const pics = await read($, picturesAtom)
        const png = await preparePicture(host, path, pics.length)
        if (!png) return null
        prepared.set(path, png)
        await update($, picturesAtom, (list) => [...list, path])
        await update($, sceneAtom, () => `pic:${pics.length}`)
        void persist()
        return path
      },
      startTicker() {
        if (ticker) return
        ticker = $.clock.every(FRAME_MS, () => {
          const run = scene
          if (run) void $.ui.blit({ requestId: PANE, key: 'scene', cells: run.frame(FRAME_MS / 1000) }).catch(() => {})
        })
      },
      stopTicker() {
        ticker?.cancel()
        ticker = null
      },
      async dispose() {
        ticker?.cancel()
        ticker = null
        await player.dispose()
      },
    }

    const saved = (await $.store.get('settings')) as Settings | undefined
    if (saved) {
      const { volume, scene: savedScene, custom, pictures, stationId } = saved
      if (typeof volume === 'number') await update($, volumeAtom, () => volume)
      if (savedScene) await update($, sceneAtom, () => savedScene)
      if (custom) await update($, customAtom, () => custom)
      if (pictures) await update($, picturesAtom, () => pictures)
      if (stationId) await update($, nowAtom, (n): MellowNow => ({ ...n, stationId, status: 'stopped' }))
    }
    void player.probe().then((tools) => update($, toolsAtom, () => tools))
    // /tmp may have been cleared since the pictures were added: convert them again.
    void (async () => {
      for (const [i, path] of (await read($, picturesAtom)).entries()) {
        const png = await preparePicture(host, path, i)
        if (png) prepared.set(path, png)
      }
    })()
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await ctl?.dispose()
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    ctl?.stopTicker()
    scene = null
    return next(e)
  })

  on('command.run', { command: 'mellow' }, async ($, e) => {
    const c = ctl
    if (!c) return { text: 'mellow is still starting; try again in a moment.' }
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    const all = await c.stations()
    const find = (q: string) => {
      const n = Number(q)
      if (Number.isInteger(n) && n >= 1 && n <= all.length) return all[n - 1]
      const low = q.toLowerCase()
      return all.find((s) => s.name.toLowerCase() === low) ?? all.find((s) => s.name.toLowerCase().includes(low))
    }

    switch (verb.toLowerCase()) {
      case '':
      case 'open':
        await $.ui.open({ id: PANE, title: 'mellow' })
        return { text: 'mellow is open.' }
      case 'play': {
        if (!arg) return { text: await c.togglePlay() }
        const st = find(arg)
        if (!st) return { text: `No station matches "${arg}". /mellow list shows them.` }
        return { text: await c.tune(st) }
      }
      case 'pause':
      case 'toggle':
        return { text: await c.togglePlay() }
      case 'stop':
        await c.stop()
        return { text: 'Stopped.' }
      case 'next':
        return { text: (await c.skip(1)) ? 'Next track.' : await c.step(1) }
      case 'prev':
        return { text: (await c.skip(-1)) ? 'Previous track.' : await c.step(-1) }
      case 'vol':
      case 'volume': {
        const n = Number(arg.replace('%', ''))
        if (!arg || !Number.isFinite(n)) return { text: `Volume is ${await read($, volumeAtom)}%.` }
        return { text: `Volume ${await c.setVolume(n)}%.` }
      }
      case 'scene':
      case 'bg': {
        if (!arg) return { text: `Picture: ${await c.cycleScene()}.` }
        const low = arg.toLowerCase()
        const hit = low === 'off' ? 'off' : SCENES.find((s) => s.id === low || s.name.toLowerCase().includes(low))?.id
        if (!hit) return { text: `Scenes: ${SCENES.map((s) => s.id).join(', ')}, off.` }
        await c.setScene(hit)
        return { text: `Picture: ${sceneName(hit, [])}.` }
      }
      case 'add': {
        const [link = '', ...nameParts] = rest
        const source = parseSource(link)
        if (!source) return { text: 'Give a YouTube, Spotify or http(s) stream link: /mellow add <link> [name]' }
        const fallback = source.kind === 'stream' ? new URL(source.url).hostname : source.kind === 'spotify' ? 'Spotify' : 'YouTube'
        const name = nameParts.join(' ') || fallback
        await c.addStation({ id: `c-${Date.now().toString(36)}`, name, tag: 'yours', source, custom: true })
        return { text: `Added and playing ${name}.` }
      }
      case 'remove':
      case 'rm': {
        const st = find(arg)
        if (!st?.custom) return { text: 'Only stations you added can be removed.' }
        await c.removeStation(st.id)
        return { text: `Removed ${st.name}.` }
      }
      case 'pic':
      case 'picture': {
        if (!arg) return { text: 'Give a path: /mellow pic ~/Pictures/cozy.jpg' }
        const path = await c.addPicture(arg)
        if (!path) return { text: `Could not read a picture at ${arg}.` }
        await $.ui.open({ id: PANE, title: 'mellow' })
        return { text: `Picture added: ${path.split('/').pop()}.` }
      }
      case 'list': {
        const { stationId } = await read($, nowAtom)
        const lines = all.map((s, i) => `${s.id === stationId ? '▶' : ' '} ${String(i + 1).padStart(2)}. ${s.name} — ${s.tag} [${kindLabel(s.source)}]`)
        return { text: lines.join('\n') }
      }
      default:
        return { text: HELP }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // The mobile app draws no Select yet; there the lists are reached by command.
    const Select = e.surface === 'mobile' ? null : $.ui.resolve(e).Select
    const c = ctl
    const now = await read($, nowAtom)
    const volume = await read($, volumeAtom)
    const sceneId = await read($, sceneAtom)
    const view = await read($, viewAtom)
    const pictures = await read($, picturesAtom)
    const tools = await read($, toolsAtom)
    const all = [...STATIONS, ...(await read($, customAtom))]
    const st = all.find((s) => s.id === now.stationId) ?? all[0]!

    const cols = Math.max(20, Math.min(240, e.props.bodyColumns))
    const sceneRows = Math.max(5, Math.min(e.props.placement === 'dock' ? 16 : 10, Math.round(cols * 0.3)))

    // Pictures need the terminal's Raster and Image; other surfaces get the controls alone.
    let picture: JSX.Element | null = null
    let art: JSX.Element | null = null
    if (e.surface === 'terminal' && sceneId !== 'off') {
      const { Raster, Image } = $.ui.resolve(e)
      if (sceneId.startsWith('pic:')) {
        c?.stopTicker()
        scene = null
        const path = pictures[Number(sceneId.slice(4))]
        const png = path ? prepared.get(path) : undefined
        picture = png ? (
          <Image source={{ file: png, format: 'png' }} columns={Math.min(255, cols)} rows={sceneRows} alt={path?.split('/').pop() ?? ' '} />
        ) : (
          <Text dimColor>preparing picture…</Text>
        )
      } else {
        const def = SCENES.find((s) => s.id === sceneId) ?? SCENES[0]!
        if (!scene || scene.def !== def || scene.columns !== cols || scene.rows !== sceneRows) scene = new SceneRun(def, cols, sceneRows)
        picture = <Raster key="scene" columns={cols} rows={sceneRows} cells={scene.frame(0)} />
        c?.startTicker()
      }
    } else {
      c?.stopTicker()
      scene = null
    }
    if (e.surface === 'terminal' && st.source.kind === 'spotify' && now.track?.art) {
      const { Image } = $.ui.resolve(e)
      art = <Image source={{ file: now.track.art, format: 'png', generation: now.track.generation }} columns={8} rows={4} alt=" " />
    }

    const playing = now.status === 'playing'
    const busy = playing || now.status === 'loading'
    const statusText =
      now.status === 'error'
        ? (now.message ?? 'Something went wrong.')
        : now.status === 'loading'
          ? (now.message ?? 'tuning in…')
          : now.track
            ? `${now.track.title} — ${now.track.artist}`
            : now.status === 'playing'
              ? st.tag
              : `${st.tag} · press k to play`

    const missing: string[] = []
    if (tools.checked && !tools.ffplay) missing.push('ffmpeg')
    if (tools.checked && !tools.ytdlp) missing.push('yt-dlp')

    const options = all.map((s, i) => ({ value: s.id, label: `${String(i + 1).padStart(2)}. ${s.name} · ${s.tag} [${kindLabel(s.source)}]` }))
    const sceneOptions = [
      ...SCENES.map((s) => ({ value: s.id, label: s.name })),
      ...pictures.map((p, i) => ({ value: `pic:${i}`, label: p.split('/').pop() ?? p })),
      { value: 'off', label: 'no picture' },
    ]

    return (
      <Box flexDirection="column">
        {picture}
        <Box flexDirection="row" gap={1} marginTop={1}>
          {art}
          <Box flexDirection="column" flexGrow={1}>
            <Text>
              <Text color={ACCENT}>{playing ? '♪ ' : now.status === 'loading' ? '… ' : '· '}</Text>
              <Text weight="bold">{st.name}</Text>
              <Text dimColor> [{kindLabel(st.source)}]</Text>
            </Text>
            {now.status === 'error' ? <Text color="error">{statusText}</Text> : <Text dimColor>{statusText}</Text>}
          </Box>
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
          <Button hotkey="j" label="⏮" plain onPress={() => void c?.step(-1)} />
          <Button hotkey="k" label={busy ? '⏸ pause' : '▶ play'} variant="primary" onPress={() => void c?.togglePlay()} />
          <Button hotkey="l" label="⏭" plain onPress={() => void c?.step(1)} />
          <Text dimColor> vol</Text>
          <Button hotkey="d" label="−" plain onPress={() => void c?.setVolume(volume - 10)} />
          <Text color={ACCENT}>{bar(volume, 10)}</Text>
          <Button hotkey="u" label="+" plain onPress={() => void c?.setVolume(volume + 10)} />
          <Text dimColor>{String(volume).padStart(3)}%</Text>
        </Box>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Button hotkey="s" label={view === 'stations' ? 'hide stations' : 'stations'} plain onPress={() => void c?.toggleView('stations')} />
          <Button hotkey="b" label={sceneName(sceneId, pictures)} plain onPress={() => void c?.cycleScene()} />
          <Button hotkey="p" label="pictures" plain onPress={() => void c?.toggleView('scenes')} />
        </Box>
        {Select && view === 'stations' && (
          <Box flexDirection="column" marginTop={1}>
            <Select
              key="station"
              options={options}
              value={st.id}
              autoFocus
              onSelect={(id: string) => {
                const s = all.find((x) => x.id === id)
                if (s) void c?.tune(s)
              }}
            />
            <Text dimColor>add your own: /mellow add &lt;youtube | spotify | stream link&gt; [name]</Text>
          </Box>
        )}
        {Select && view === 'scenes' && (
          <Box flexDirection="column" marginTop={1}>
            <Select key="scene" options={sceneOptions} value={sceneId} autoFocus onSelect={(id: string) => void c?.setScene(id)} />
            <Text dimColor>your own: /mellow pic ~/Pictures/cozy.jpg</Text>
          </Box>
        )}
        {missing.length > 0 && <Text color="warning">needs {missing.join(' + ')}: brew install {missing.join(' ')}</Text>}
        {st.source.kind === 'spotify' && tools.checked && !tools.spotify && (
          <Text color="warning">Spotify stations drive the Spotify desktop app (macOS).</Text>
        )}
      </Box>
    )
  })
}
