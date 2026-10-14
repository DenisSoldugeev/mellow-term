export type MellowSource =
  | { kind: 'youtube'; id: string; channel?: string; match?: string }
  | { kind: 'spotify'; uri: string }
  | { kind: 'stream'; url: string }

export type MellowStation = {
  id: string
  name: string
  tag: string
  source: MellowSource
  custom?: boolean
}

export type MellowStatus = 'stopped' | 'loading' | 'playing' | 'paused' | 'error'

export type MellowTrack = { title: string; artist: string; art?: string; generation: number }

export type MellowNow = {
  stationId: string
  status: MellowStatus
  message?: string
  track?: MellowTrack
}

export type MellowTools = { ffplay: boolean; ytdlp: boolean; spotify: boolean; checked: boolean }

export type MellowView = 'player' | 'stations' | 'scenes'

declare module 'claude-code' {
  interface PluginState {
    mellow: {
      now: MellowNow
      volume: number
      scene: string
      view: MellowView
      custom: MellowStation[]
      pictures: string[]
      tools: MellowTools
    }
  }
}
