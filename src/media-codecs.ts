/**
 * Распознавание кодеков внутри MP4 и WebM без внешних программ.
 *
 * Зачем: контейнер MP4/WebM — только «коробка». Браузерный движок OBS Studio и Streamlabs Desktop (Chromium/CEF)
 * надёжно играет видео H.264 / VP8 / VP9 / AV1 и звук AAC / MP3 / Opus / Vorbis / FLAC. Файлы с телефонов,
 * старых камер и программ монтажа бывают в H.265, MPEG-4 Part 2, ProRes, со звуком AC-3 и т. п. — проверка
 * формата по сигнатуре их пропускает, а в программе для стрима они не играют (MEDIA_ERR_SRC_NOT_SUPPORTED).
 */

export interface CodecTrack {
  type: 'video' | 'audio';
  /** Код кодека: FourCC MP4 (avc1, hvc1, mp4a…) или CodecID WebM (V_VP9, A_OPUS…). */
  id: string;
  /** Понятное название, например «H.264», «AAC», «AC-3 (Dolby Digital)». */
  name: string;
  /** Поддерживается ли браузерным движком OBS/Streamlabs. */
  ok: boolean;
  /** Пояснение для пользователя, если не поддерживается. */
  note?: string;
}

const MAX_BOXES = 10_000;

/** Кодеки MP4: FourCC → название и поддержка. */
const MP4_VIDEO: Record<string, { name: string; ok: boolean; note?: string }> = {
  avc1: { name: 'H.264', ok: true }, avc3: { name: 'H.264', ok: true },
  vp08: { name: 'VP8', ok: true }, vp09: { name: 'VP9', ok: true }, av01: { name: 'AV1', ok: true },
  hvc1: { name: 'H.265/HEVC', ok: false, note: 'может не воспроизводиться' }, hev1: { name: 'H.265/HEVC', ok: false, note: 'может не воспроизводиться' },
  dvh1: { name: 'Dolby Vision', ok: false }, dvhe: { name: 'Dolby Vision', ok: false },
  mp4v: { name: 'MPEG-4 Part 2 (DivX/Xvid)', ok: false }, s263: { name: 'H.263', ok: false },
  jpeg: { name: 'Motion JPEG', ok: false }, mjpa: { name: 'Motion JPEG', ok: false }, mjpb: { name: 'Motion JPEG', ok: false },
  apcn: { name: 'Apple ProRes', ok: false }, apch: { name: 'Apple ProRes', ok: false }, apcs: { name: 'Apple ProRes', ok: false },
  apco: { name: 'Apple ProRes', ok: false }, ap4h: { name: 'Apple ProRes', ok: false }, ap4x: { name: 'Apple ProRes', ok: false },
  'raw ': { name: 'несжатое видео', ok: false }, mpg2: { name: 'MPEG-2', ok: false },
};
const MP4_AUDIO: Record<string, { name: string; ok: boolean }> = {
  Opus: { name: 'Opus', ok: true }, fLaC: { name: 'FLAC', ok: true }, '.mp3': { name: 'MP3', ok: true },
  'ac-3': { name: 'AC-3 (Dolby Digital)', ok: false }, 'ec-3': { name: 'E-AC-3 (Dolby Digital Plus)', ok: false }, 'ac-4': { name: 'AC-4 (Dolby)', ok: false },
  alac: { name: 'Apple Lossless (ALAC)', ok: false }, samr: { name: 'AMR', ok: false }, sawb: { name: 'AMR-WB', ok: false },
  twos: { name: 'PCM', ok: false }, sowt: { name: 'PCM', ok: false }, lpcm: { name: 'PCM', ok: false }, ipcm: { name: 'PCM', ok: false },
  fpcm: { name: 'PCM', ok: false }, 'in24': { name: 'PCM', ok: false }, 'in32': { name: 'PCM', ok: false }, ulaw: { name: 'μ-law', ok: false }, alaw: { name: 'A-law', ok: false },
  'dtsc': { name: 'DTS', ok: false }, 'dtsh': { name: 'DTS', ok: false }, 'dtsl': { name: 'DTS', ok: false }, 'dtse': { name: 'DTS', ok: false },
};
/** Профили H.264, которые Chromium не декодирует (10 бит, 4:2:2, 4:4:4). */
const H264_UNSUPPORTED_PROFILES: Record<number, string> = { 110: 'High 10 (10 бит)', 122: 'High 4:2:2', 244: 'High 4:4:4', 44: 'CAVLC 4:4:4' };

/** Кодеки MP4 и WebM в файле. Пустой массив — дорожки не найдены (повреждённый или необычный файл). */
export function detectCodecs(buf: Buffer, container: 'mp4' | 'webm'): CodecTrack[] {
  try {
    return container === 'mp4' ? mp4Codecs(buf) : webmCodecs(buf);
  } catch {
    return [];
  }
}

/** Человекочитаемое описание: «видео H.264, звук AAC». */
export function describeCodecs(tracks: CodecTrack[]): string {
  const v = [...new Set(tracks.filter((t) => t.type === 'video').map((t) => t.name))];
  const a = [...new Set(tracks.filter((t) => t.type === 'audio').map((t) => t.name))];
  return [v.length ? `видео ${v.join(', ')}` : '', a.length ? `звук ${a.join(', ')}` : ''].filter(Boolean).join(', ');
}

/**
 * Предупреждения о несовместимых кодеках для OBS/Streamlabs. Пустой массив — всё в порядке.
 * В тексте — что делать: кнопка «Перекодировать» в разделе «Медиа».
 */
export function codecWarnings(tracks: CodecTrack[]): string[] {
  const bad = tracks.filter((t) => !t.ok);
  if (!bad.length) return [];
  const video = bad.filter((t) => t.type === 'video');
  const audio = bad.filter((t) => t.type === 'audio');
  const parts: string[] = [];
  if (video.length) parts.push(`видео в кодеке ${[...new Set(video.map((t) => t.name + (t.note ? ` — ${t.note}` : '')))].join(', ')}`);
  if (audio.length) parts.push(`звук в формате ${[...new Set(audio.map((t) => t.name))].join(', ')}`);
  const hevcOnly = video.length > 0 && video.every((t) => t.id === 'hvc1' || t.id === 'hev1') && !audio.length;
  const verdict = hevcOnly ? 'может не воспроизводиться в OBS и Streamlabs' : (video.length ? 'не воспроизводится' : 'не воспроизводится со звуком') + ' в OBS и Streamlabs';
  return [`В файле ${parts.join(' и ')} — ${verdict}. Нажмите «Перекодировать» (раздел «Медиатека») или сохраните файл как MP4 (H.264 + AAC).`];
}

// ---------------- MP4 ----------------

interface Box { type: string; start: number; body: number; end: number }

function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let pos = from;
  let n = 0;
  while (pos + 8 <= to && n++ < MAX_BOXES) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) return;
      const big = buf.readBigUInt64BE(pos + 8);
      if (big > BigInt(to - pos)) return;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < header || pos + size > to) return;
    yield { type, start: pos, body: pos + header, end: pos + size };
    pos += size;
  }
}

function child(buf: Buffer, parent: Box, type: string): Box | undefined {
  for (const b of boxes(buf, parent.body, parent.end)) if (b.type === type) return b;
  return undefined;
}

function mp4Codecs(buf: Buffer): CodecTrack[] {
  const out: CodecTrack[] = [];
  let moov: Box | undefined;
  for (const b of boxes(buf, 0, buf.length)) if (b.type === 'moov') { moov = b; break; }
  if (!moov) return out;
  for (const trak of boxes(buf, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(buf, trak, 'mdia');
    const minf = mdia && child(buf, mdia, 'minf');
    const stbl = minf && child(buf, minf, 'stbl');
    const stsd = stbl && child(buf, stbl, 'stsd');
    if (!stsd || stsd.body + 8 > stsd.end) continue;
    const handler = mdia ? hdlrType(buf, mdia) : '';
    // stsd: version/flags (4), entry_count (4), затем записи — тоже в формате box (FourCC кодека).
    for (const entry of boxes(buf, stsd.body + 8, stsd.end)) {
      const fourcc = entry.type;
      if (handler === 'vide' || MP4_VIDEO[fourcc]) out.push(videoTrack(buf, entry, fourcc));
      else if (handler === 'soun' || MP4_AUDIO[fourcc] || fourcc === 'mp4a') out.push(audioTrack(buf, entry, fourcc));
    }
  }
  return out;
}

function hdlrType(buf: Buffer, mdia: Box): string {
  const h = child(buf, mdia, 'hdlr');
  return h && h.body + 12 <= h.end ? buf.toString('latin1', h.body + 8, h.body + 12) : '';
}

function videoTrack(buf: Buffer, entry: Box, fourcc: string): CodecTrack {
  const known = MP4_VIDEO[fourcc];
  if (!known) return { type: 'video', id: fourcc, name: `«${printable(fourcc)}»`, ok: false, note: 'неизвестный кодек' };
  if (fourcc === 'avc1' || fourcc === 'avc3') {
    // VisualSampleEntry: 8 (заголовок) + 70 байт полей, затем вложенные box, среди них avcC.
    const inner = { type: fourcc, start: entry.start, body: entry.body + 70, end: entry.end };
    const avcC = inner.body < inner.end ? child(buf, inner, 'avcC') : undefined;
    if (avcC && avcC.body + 2 <= avcC.end) {
      const profile = buf[avcC.body + 1];
      const bad = H264_UNSUPPORTED_PROFILES[profile];
      if (bad) return { type: 'video', id: fourcc, name: `H.264 ${bad}`, ok: false };
    }
  }
  return { type: 'video', id: fourcc, name: known.name, ok: known.ok, note: known.note };
}

function audioTrack(buf: Buffer, entry: Box, fourcc: string): CodecTrack {
  if (fourcc === 'mp4a') {
    // AudioSampleEntry: 8 + 28 байт, затем esds с DecoderConfigDescriptor (objectTypeIndication).
    const inner = { type: fourcc, start: entry.start, body: entry.body + 28, end: entry.end };
    const esds = inner.body < inner.end ? child(buf, inner, 'esds') : undefined;
    const oti = esds ? objectType(buf, esds.body + 4, esds.end) : -1;
    if (oti === -1 || oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68) return { type: 'audio', id: 'mp4a', name: 'AAC', ok: true };
    if (oti === 0x69 || oti === 0x6b) return { type: 'audio', id: 'mp4a', name: 'MP3', ok: true };
    if (oti === 0xa5) return { type: 'audio', id: 'mp4a', name: 'AC-3 (Dolby Digital)', ok: false };
    if (oti === 0xa6) return { type: 'audio', id: 'mp4a', name: 'E-AC-3 (Dolby Digital Plus)', ok: false };
    if (oti === 0xa9 || oti === 0xaa || oti === 0xab || oti === 0xac) return { type: 'audio', id: 'mp4a', name: 'DTS', ok: false };
    return { type: 'audio', id: 'mp4a', name: `MPEG-4 Audio (0x${oti.toString(16)})`, ok: false };
  }
  const known = MP4_AUDIO[fourcc];
  return known ? { type: 'audio', id: fourcc, ...known } : { type: 'audio', id: fourcc, name: `«${printable(fourcc)}»`, ok: false };
}

/** Поиск DecoderConfigDescriptor (тег 0x04) в дескрипторах esds; возвращает objectTypeIndication. */
function objectType(buf: Buffer, from: number, to: number): number {
  let pos = from;
  for (let guard = 0; pos < to && guard < 64; guard++) {
    const tag = buf[pos++];
    let len = 0;
    for (let i = 0; i < 4 && pos < to; i++) {
      const b = buf[pos++];
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    if (tag === 0x03) { // ES_Descriptor: ES_ID (2) + флаги (1) [+ необязательные поля]
      const flags = buf[pos + 2];
      pos += 3;
      if (flags & 0x80) pos += 2;
      if (flags & 0x40) pos += 1 + buf[pos];
      if (flags & 0x20) pos += 2;
      continue;
    }
    if (tag === 0x04) return pos < to ? buf[pos] : -1;
    pos += len;
  }
  return -1;
}

function printable(s: string): string { return s.replace(/[^\x20-\x7e]/g, '?'); }

// ---------------- WebM ----------------

const WEBM_CODECS: Record<string, { type: 'video' | 'audio'; name: string; ok: boolean }> = {
  V_VP8: { type: 'video', name: 'VP8', ok: true }, V_VP9: { type: 'video', name: 'VP9', ok: true }, V_AV1: { type: 'video', name: 'AV1', ok: true },
  'V_MPEG4/ISO/AVC': { type: 'video', name: 'H.264', ok: false }, 'V_MPEGH/ISO/HEVC': { type: 'video', name: 'H.265/HEVC', ok: false },
  A_OPUS: { type: 'audio', name: 'Opus', ok: true }, A_VORBIS: { type: 'audio', name: 'Vorbis', ok: true },
  A_AAC: { type: 'audio', name: 'AAC', ok: false }, A_AC3: { type: 'audio', name: 'AC-3 (Dolby Digital)', ok: false }, A_EAC3: { type: 'audio', name: 'E-AC-3', ok: false },
  'A_MPEG/L3': { type: 'audio', name: 'MP3', ok: false }, A_FLAC: { type: 'audio', name: 'FLAC', ok: false },
};

/** CodecID в WebM (элемент 0x86) — строки вида V_VP9, A_OPUS в заголовке дорожек. */
function webmCodecs(buf: Buffer): CodecTrack[] {
  const head = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  const out: CodecTrack[] = [];
  for (let i = 0; i + 2 < head.length; i++) {
    if (head[i] !== 0x86) continue;
    const size = head[i + 1];
    if (!(size & 0x80)) continue; // размер CodecID — однобайтовый vint
    const len = size & 0x7f;
    if (len < 3 || len > 24 || i + 2 + len > head.length) continue;
    const id = head.toString('latin1', i + 2, i + 2 + len);
    if (!/^[AV]_[A-Z0-9/]+$/.test(id)) continue;
    const known = WEBM_CODECS[id];
    out.push(known ? { id, ...known } : { type: id.startsWith('V_') ? 'video' : 'audio', id, name: id, ok: false });
  }
  return out;
}
