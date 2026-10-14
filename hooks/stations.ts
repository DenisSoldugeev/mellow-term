import type { MellowSource, MellowStation } from '../types'

// Live stream IDs change when a channel restarts a stream; `channel` + `match`
// let the player find the current one on the channel's streams tab.
const yt = (id: string, name: string, tag: string, channel: string, match: string): MellowStation => ({
  id: `yt-${id}`,
  name,
  tag,
  source: { kind: 'youtube', id, channel, match },
})

export const STATIONS: MellowStation[] = [
  yt('rFZHOHl-L8A', 'Lofi Girl', 'beats to relax / study', 'LofiGirl', 'beats to relax/study'),
  yt('JD-kMIpDfnY', 'Sleepy Lofi', 'beats to sleep / chill', 'LofiGirl', 'beats to sleep/chill'),
  yt('E2vONfzoyRI', 'Jazz Lofi', 'saxophone & soft keys', 'LofiGirl', 'jazz lofi radio'),
  yt('CwPCy1GLS38', 'Rainy Lofi', 'beats for rainy days', 'LofiGirl', 'sad lofi radio'),
  yt('1Tl2FtV06qo', 'Asian Lofi', 'koto & warm tape', 'LofiGirl', 'asian lofi radio'),
  yt('3PFJ9SETS4M', 'Lofi House', 'lounge to vibe to', 'LofiGirl', 'lofi house radio'),
  yt('4xDzrJKXOOY', 'Synthwave', 'neon drive', 'LofiGirl', 'synthwave radio'),
  yt('GSfT7H87zq4', 'Deep Space', 'synth ambient', 'LofiGirl', 'synth ambient radio'),
  yt('5yx6BWlEVcY', 'Chillhop Radio', 'jazzy & lofi hip hop', 'ChillhopMusic', 'Chillhop Radio'),
  yt('i6WzngxTnBA', 'Late Night Vibes', 'calm, dreamy beats', 'ChillhopMusic', 'late night vibes'),
  yt('Dx5qFachd3A', 'Jazz Piano Cafe', 'slow jazz for work', 'CafeMusicBGMchannel', 'Relaxing Jazz Piano Radio'),
  yt('DSGyEsJ17cI', 'Rainy Jazz', 'jazz & bossa nova', 'CafeMusicBGMchannel', 'Rainy Jazz'),
  { id: 'sp-lofi-beats', name: 'lofi beats', tag: 'Spotify', source: { kind: 'spotify', uri: 'spotify:playlist:37i9dQZF1DWWQRwui0ExPn' } },
  { id: 'sp-study', name: 'chill lofi study beats', tag: 'Spotify', source: { kind: 'spotify', uri: 'spotify:playlist:37i9dQZF1DX8Uebhn9wzrS' } },
  { id: 'sp-late-jazz', name: 'Late Night Jazz', tag: 'Spotify', source: { kind: 'spotify', uri: 'spotify:playlist:37i9dQZF1DX4wta20PHgwo' } },
  { id: 'sp-slow', name: 'slow living', tag: 'Spotify', source: { kind: 'spotify', uri: 'spotify:playlist:37i9dQZF1DXc8kgYqQLMfH' } },
]

/** Turns a pasted link into a source: YouTube, Spotify, or any http(s) audio stream. */
export function parseSource(input: string): MellowSource | null {
  const text = input.trim()
  if (!text) return null
  if (/^spotify:(playlist|album|artist|track|show|episode):[A-Za-z0-9]+$/.test(text)) return { kind: 'spotify', uri: text }
  const sp = text.match(/open\.spotify\.com\/(?:intl-[\w-]+\/)?(playlist|album|artist|track|show|episode)\/([A-Za-z0-9]+)/)
  if (sp) return { kind: 'spotify', uri: `spotify:${sp[1]}:${sp[2]}` }
  const y = text.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/)
  if (y?.[1]) return { kind: 'youtube', id: y[1] }
  if (/^https?:\/\/\S+$/.test(text)) return { kind: 'stream', url: text }
  return null
}

export const kindLabel = (s: MellowSource): string =>
  s.kind === 'youtube' ? 'live' : s.kind === 'spotify' ? 'spotify' : 'radio'
