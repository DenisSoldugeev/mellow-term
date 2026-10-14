import type { HookStream, ProcessRunInit, ProcessRunResult, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult, Timer } from 'claude-code'

import type { MellowNow, MellowStation, MellowTools, MellowTrack } from '../types'

// Audio runs outside the mod's sandbox: ffplay plays the stream, yt-dlp turns a
// YouTube live page into its HLS manifest, and on macOS the Spotify app is
// driven through AppleScript.

type Report = (patch: Partial<MellowNow>) => Promise<void>

/** What the player needs from the engine, handed in as closures over the hook's `$`. */
export type Host = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  after: (ms: number, fn: () => void) => Timer
  every: (ms: number, fn: () => void) => Timer
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  stat: (path: string) => Promise<unknown>
}

const TMP = '/tmp/mellow'
const FFPLAY = ['ffplay', '/opt/homebrew/bin/ffplay', '/usr/local/bin/ffplay', '/usr/bin/ffplay']
const YTDLP = ['yt-dlp', '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']

export class Player {
  private ffplay = 'ffplay'
  private ytdlp = 'yt-dlp'
  private child: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null = null
  /** Bumped on every start and stop, so a child that ends late cannot report over a newer one. */
  private generation = 0
  private url: { stationId: string; url: string } | null = null
  private retries = 0
  private spotifyActive = false
  private spotifyPoll: Timer | null = null
  private artUrl = ''
  private artGeneration = 0
  private volumeTimer: Timer | null = null
  station: MellowStation | null = null
  volume = 60
  isPaused = true

  constructor(
    private readonly host: Host,
    private readonly report: Report,
  ) {}

  /** Finds the binaries; called once per session. */
  async probe(): Promise<MellowTools> {
    const find = async (candidates: string[]) => {
      for (const bin of candidates) {
        try {
          const { exitCode } = await this.host.run([bin, '--version'], { timeoutMs: 8000 })
          if (exitCode === 0) return bin
        } catch {
          /* not here */
        }
      }
      return null
    }
    const [ff, yt] = await Promise.all([find(FFPLAY), find(YTDLP)])
    if (ff) this.ffplay = ff
    if (yt) this.ytdlp = yt
    let spotify = false
    try {
      await this.host.stat('/Applications/Spotify.app')
      spotify = true
    } catch {
      /* no Spotify app on this machine */
    }
    void this.host.run(['mkdir', '-p', TMP]).catch(() => {})
    return { ffplay: ff !== null, ytdlp: yt !== null, spotify, checked: true }
  }

  async play(station: MellowStation): Promise<void> {
    const my = ++this.generation
    this.station = station
    this.isPaused = false
    this.retries = 0
    await this.killChild()
    if (station.source.kind === 'spotify') {
      await this.report({ stationId: station.id, status: 'loading', message: undefined, track: undefined })
      const ok = await this.osa(`tell application "Spotify"
        set sound volume to ${this.volume}
        play track "${station.source.uri}"
      end tell`)
      if (my !== this.generation) return
      if (!ok) return this.report({ status: 'error', message: 'Spotify did not answer. Is the app installed and signed in?' })
      this.spotifyActive = true
      this.startSpotifyPoll()
      return this.report({ status: 'playing' })
    }
    if (this.spotifyActive) await this.pauseSpotify()
    if (this.url?.stationId !== station.id) this.url = null
    await this.report({ stationId: station.id, status: 'loading', message: undefined, track: undefined })
    await this.startStream(my)
  }

  async pause(): Promise<void> {
    this.isPaused = true
    this.generation++
    if (this.spotifyActive) await this.pauseSpotify(true)
    await this.killChild()
    await this.report({ status: 'paused' })
  }

  async resume(): Promise<void> {
    if (!this.station) return
    if (this.station.source.kind === 'spotify' && this.spotifyActive) {
      this.isPaused = false
      await this.osa('tell application "Spotify" to play')
      return this.report({ status: 'playing' })
    }
    const my = ++this.generation
    this.isPaused = false
    await this.report({ status: 'loading' })
    await this.startStream(my)
  }

  async stop(): Promise<void> {
    this.generation++
    this.isPaused = true
    await this.killChild()
    if (this.spotifyActive) await this.pauseSpotify()
    await this.report({ status: 'stopped', track: undefined })
  }

  /** Spotify skips inside its playlist; streams have no tracks to skip. */
  async skip(delta: 1 | -1): Promise<boolean> {
    if (!this.spotifyActive || this.station?.source.kind !== 'spotify') return false
    await this.osa(`tell application "Spotify" to ${delta > 0 ? 'next track' : 'previous track'}`)
    return true
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(100, Math.round(volume)))
    if (this.spotifyActive) {
      void this.osa(`tell application "Spotify" to set sound volume to ${this.volume}`)
      return
    }
    // ffplay takes its volume at start only; restart once the keys settle.
    this.volumeTimer?.cancel()
    if (!this.child || this.isPaused) return
    this.volumeTimer = this.host.after(450, () => {
      this.volumeTimer = null
      if (this.isPaused || !this.station) return
      const my = ++this.generation
      void this.startStream(my)
    })
  }

  async dispose(): Promise<void> {
    this.spotifyPoll?.cancel()
    this.volumeTimer?.cancel()
    await this.killChild()
  }

  // ---------- streams ----------

  private async startStream(my: number): Promise<void> {
    const station = this.station
    if (!station || station.source.kind === 'spotify') return
    let url = this.url?.stationId === station.id ? this.url.url : null
    if (!url) {
      url = station.source.kind === 'stream' ? station.source.url : await this.resolveYouTube(station)
      if (my !== this.generation) return
      if (!url) return this.report({ status: 'error', message: 'Could not find this live stream. Try another station.' })
      this.url = { stationId: station.id, url }
    }
    await this.killChild()
    if (my !== this.generation) return

    const child = this.host.spawn({
      argv: [this.ffplay, '-nodisp', '-vn', '-loglevel', 'error', '-volume', String(this.volume), url],
    })
    this.child = child
    const startedAt = Date.now()
    void this.report({ status: 'playing', message: undefined })
    void (async () => {
      let lastError = ''
      try {
        for await (const chunk of child) if (chunk.stream === 'stderr') lastError = chunk.text.trim().split('\n').pop() ?? lastError
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      if (this.child === child) this.child = null
      if (my !== this.generation) return
      // A live manifest expires after some hours and a network blip ends ffplay:
      // fetch a fresh URL and go again, a few times.
      if (this.retries < 3) {
        this.retries++
        this.url = null
        if (Date.now() - startedAt > 60_000) this.retries = 0
        await this.report({ status: 'loading', message: 'Reconnecting…' })
        return this.startStream(my)
      }
      await this.report({ status: 'error', message: lastError || 'The stream stopped.' })
    })()
  }

  private async killChild(): Promise<void> {
    const child = this.child
    this.child = null
    if (child) await child.return(undefined as never).catch(() => {})
  }

  private async resolveYouTube(station: MellowStation): Promise<string | null> {
    if (station.source.kind !== 'youtube') return null
    const src = station.source
    const override = (await this.host.storeGet(`yt:${station.id}`)) as string | undefined
    const tryId = async (id: string) => {
      try {
        const { exitCode, stdout } = await this.host.run(
          [this.ytdlp, '--no-warnings', '-f', '91/92/93/94/bestaudio/best', '-g', `https://www.youtube.com/watch?v=${id}`],
          { timeoutMs: 45_000 },
        )
        const line = stdout.split('\n').find((l) => l.startsWith('http'))
        return exitCode === 0 && line ? line.trim() : null
      } catch {
        return null
      }
    }
    const first = await tryId(override ?? src.id)
    if (first || !src.channel || !src.match) return first
    // The stream was restarted under a new ID: look for it on the channel.
    try {
      const { stdout } = await this.host.run(
        [this.ytdlp, '--no-warnings', '--flat-playlist', '--playlist-end', '40', '--print', '%(id)s|%(live_status)s|%(title)s', `https://www.youtube.com/@${src.channel}/streams`],
        { timeoutMs: 60_000 },
      )
      const want = src.match.toLowerCase()
      const hit = stdout
        .split('\n')
        .map((l) => l.split('|'))
        .find(([, status, ...title]) => status === 'is_live' && title.join('|').toLowerCase().includes(want))
      if (!hit?.[0]) return null
      await this.host.storeSet(`yt:${station.id}`, hit[0])
      return tryId(hit[0])
    } catch {
      return null
    }
  }

  // ---------- spotify ----------

  private async osa(script: string): Promise<string | null> {
    try {
      const { exitCode, stdout } = await this.host.run(['osascript', '-e', script], { timeoutMs: 15_000 })
      return exitCode === 0 ? stdout.trim() || 'ok' : null
    } catch {
      return null
    }
  }

  private async pauseSpotify(keepActive = false): Promise<void> {
    await this.osa('if application "Spotify" is running then tell application "Spotify" to pause')
    if (!keepActive) {
      this.spotifyActive = false
      this.spotifyPoll?.cancel()
      this.spotifyPoll = null
    }
  }

  private startSpotifyPoll(): void {
    this.spotifyPoll?.cancel()
    const poll = async () => {
      const out = await this.osa(`if application "Spotify" is running then
        tell application "Spotify"
          set t to current track
          return (name of t) & linefeed & (artist of t) & linefeed & (artwork url of t) & linefeed & (player state as text)
        end tell
      end if`)
      if (!out || !this.spotifyActive) return
      const [title = '', artist = '', art = '', state = ''] = out.split('\n')
      const track: MellowTrack = { title, artist, generation: this.artGeneration }
      if (art && art !== this.artUrl) {
        this.artUrl = art
        track.art = (await this.fetchArt(art)) ?? undefined
      } else if (this.artGeneration > 0) track.art = `${TMP}/art-${this.artGeneration}.png`
      track.generation = this.artGeneration
      await this.report({ track, status: state === 'playing' ? 'playing' : 'paused' })
    }
    void poll()
    this.spotifyPoll = this.host.every(3000, () => void poll())
  }

  /** The terminal's image protocol takes PNG: fetch the cover and convert it with sips. */
  private async fetchArt(url: string): Promise<string | null> {
    const n = this.artGeneration + 1
    const jpg = `${TMP}/art.jpg`
    const png = `${TMP}/art-${n}.png`
    try {
      const got = await this.host.run(['curl', '-sfL', '--max-time', '10', '-o', jpg, url], { timeoutMs: 15_000 })
      if (got.exitCode !== 0) return null
      const conv = await this.host.run(['sips', '-s', 'format', 'png', '-Z', '240', jpg, '--out', png], { timeoutMs: 15_000 })
      if (conv.exitCode !== 0) return null
      if (n > 1) void this.host.run(['rm', '-f', `${TMP}/art-${n - 1}.png`]).catch(() => {})
      this.artGeneration = n
      return png
    } catch {
      return null
    }
  }
}

/** Converts a user picture to PNG (the terminal's image protocol needs it); PNGs pass through. */
export async function preparePicture(host: Host, path: string, index: number): Promise<string | null> {
  if (/\.png$/i.test(path)) return path
  const out = `${TMP}/pic-${index}.png`
  try {
    await host.run(['mkdir', '-p', TMP])
    const { exitCode } = await host.run(['sips', '-s', 'format', 'png', '-Z', '1200', path, '--out', out], { timeoutMs: 20_000 })
    return exitCode === 0 ? out : null
  } catch {
    return null
  }
}
