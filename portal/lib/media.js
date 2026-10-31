// Video/audio playback in the browser, with ffmpeg.
// - probe(): codecs, audio and subtitle tracks, and whether the browser can read the file as is ("direct")
// - streamArgs(): on-the-fly conversion to fragmented MP4 that every browser plays. H.264 video is copied
//   (almost no CPU), anything else is re-encoded to 720p H.264; the chosen audio track becomes stereo AAC.
// - subtitleVtt(): a subtitle track embedded in the file, as WebVTT
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

export class MediaError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function run(cmd, args, { timeoutMs, maxBytes = 50 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) child.kill('SIGKILL');
      else out.push(c);
    });
    child.stderr.on('data', (c) => (err = (err + c).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new MediaError(e.code === 'ENOENT' ? `${cmd} absent du serveur` : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new MediaError(`${path.basename(cmd)} a échoué : ${err.trim().split('\n').pop() || code}`, 422));
    });
  });
}

// Small cache: files do not change once downloaded (key includes size and date)
const cache = new Map();
async function cachedFor(file, kind, fn) {
  const st = await fs.stat(file);
  const key = `${kind}:${file}:${st.size}:${st.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const value = await fn();
  cache.set(key, value);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}

const DIRECT_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.wav']);
const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le']);
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
// 8-bit 4:2:0 only: browsers do not decode 10-bit H.264
const H264_OK = (v) => v.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(v.pix_fmt);

const LANGS = { fre: 'Français', fra: 'Français', fr: 'Français', eng: 'Anglais', en: 'Anglais', spa: 'Espagnol', ger: 'Allemand', deu: 'Allemand', ita: 'Italien', jpn: 'Japonais', por: 'Portugais', und: '' };

function label(s, i, kind) {
  const lang = s.tags?.language;
  const title = s.tags?.title;
  const parts = [LANGS[lang] ?? lang, title].filter(Boolean);
  if (kind === 'audio') parts.push(`${s.codec_name}${s.channels > 2 ? ` ${s.channels === 6 ? '5.1' : s.channels === 8 ? '7.1' : s.channels + 'ch'}` : ''}`);
  return parts.join(' · ') || `Piste ${i + 1}`;
}

export function probe(file) {
  return cachedFor(file, 'probe', async () => {
    const raw = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 30000 });
    const info = JSON.parse(raw.toString('utf8'));
    const streams = info.streams || [];
    // Cover art (attached pictures) is not the video
    const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audio = streams.filter((s) => s.codec_type === 'audio');
    const subs = streams.filter((s) => s.codec_type === 'subtitle');
    const defaultAudio = Math.max(0, audio.findIndex((s) => s.disposition?.default));
    const ext = path.extname(file).toLowerCase();
    const direct =
      DIRECT_CONTAINERS.has(ext) &&
      (!v || DIRECT_VIDEO.has(v.codec_name) && (v.codec_name !== 'h264' || H264_OK(v))) &&
      audio.length <= 1 &&
      audio.every((a) => DIRECT_AUDIO.has(a.codec_name));
    return {
      duration: Number(info.format?.duration) || null,
      video: v ? { codec: v.codec_name, width: v.width, height: v.height, copy: H264_OK(v) } : null,
      audio: audio.map((s, i) => ({ index: i, label: label(s, i, 'audio'), codec: s.codec_name, default: i === defaultAudio })),
      subtitles: subs.map((s, i) => ({ index: i, label: label(s, i, 'sub'), codec: s.codec_name, text: TEXT_SUBS.has(s.codec_name) }))
        .filter((s) => s.text),
      defaultAudio,
      direct,
    };
  });
}

export function streamArgs(file, info, { start = 0, audio = info.defaultAudio }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', file);
  if (info.video) {
    args.push('-map', '0:v:0');
    if (info.video.copy) args.push('-c:v', 'copy');
    else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '5M', '-bufsize', '10M',
        '-vf', "scale='min(1280,iw)':-2", '-pix_fmt', 'yuv420p');
    }
  }
  if (info.audio.length) args.push('-map', `0:a:${Math.min(Math.max(0, audio), info.audio.length - 1)}`, '-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push('-sn', '-dn', '-map_chapters', '-1', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
  return args;
}

export function spawnStream(args) {
  return spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function subtitleVtt(file, track) {
  return cachedFor(file, `sub${track}`, async () => {
    const out = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-map', `0:s:${track}`, '-f', 'webvtt', 'pipe:1'], {
      timeoutMs: 180000,
      maxBytes: 10 * 1024 * 1024,
    });
    return out.toString('utf8');
  });
}
