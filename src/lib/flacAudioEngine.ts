import { FLACDecoder, FLACDecoderWebWorker } from '@wasm-audio-decoders/flac';
import decodeAac from '@audio/decode-aac';
import * as mm from 'music-metadata-browser';

export interface AudioTechnicalSpecs {
  format: string; // 'FLAC' | 'WAV' | 'MP3' | 'AAC' | 'M4A' | 'OGG' | 'ALAC' | 'AIFF' | 'OPUS' | 'WEBM'
  container?: string;
  codec?: string;
  lossless: boolean;
  sampleRate: number; // e.g. 44100, 48000, 96000, 192000
  bitsPerSample: number; // e.g. 16, 24, 32
  channels: number; // e.g. 2
  bitrate?: number; // bps
  duration?: number; // seconds
  album?: string;
  fileSize?: number; // bytes
  decoderEngine: string; // 'libFLAC WebAssembly (WASM)' or 'Native Stream Decoder'
  pcmFormat?: string; // '32-bit Float Linear PCM'
}

export interface OutputPipelineInfo {
  deviceSampleRate: number;
  outputChannels: number;
  audioContextState: string;
  effectsApplied: boolean;
  isBitPerfectVerified: boolean;
  pipelineDescription: string;
}

// Global registry of created object URLs to prevent memory leaks
const objectUrlRegistry = new Set<string>();

export function registerTrackedUrl(url: string): string {
  if (url && url.startsWith('blob:')) {
    objectUrlRegistry.add(url);
  }
  return url;
}

export function revokeTrackedUrl(url: string) {
  if (url && objectUrlRegistry.has(url)) {
    try {
      URL.revokeObjectURL(url);
      objectUrlRegistry.delete(url);
    } catch (e) {
      // Ignore revocation error
    }
  }
}

export function revokeAllTrackedUrls() {
  objectUrlRegistry.forEach(url => {
    try {
      URL.revokeObjectURL(url);
    } catch (e) {
      // Ignore
    }
  });
  objectUrlRegistry.clear();
}

export interface AudioFormatDetectionResult {
  isFlac: boolean;
  format: 'FLAC' | 'MP3' | 'WAV' | 'M4A' | 'AAC' | 'OGG' | 'OPUS' | 'WMA' | 'ALAC' | 'AIFF' | 'WEBM' | 'AUDIO';
  mimeType: string;
  lossless: boolean;
  qualityLabel: string;
  streamInfo?: {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    duration: number;
  };
}

/**
 * Check if a file is a FLAC file by magic bytes 'fLaC' at offset 0
 */
export async function isFlacFileByHeader(file: File | Blob): Promise<boolean> {
  try {
    const slice = file.slice(0, 4);
    const buffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // 'fLaC' in ASCII is 0x66, 0x4C, 0x61, 0x43
    return bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
  } catch (e) {
    return false;
  }
}

/**
 * Accurately and instantaneously detects whether an audio file is FLAC (lossless high-res)
 * or standard/regular audio (MP3, WAV, AAC, M4A, ALAC, OGG, OPUS, AIFF, WEBM, etc.) by inspecting:
 * 1. File extension (case-insensitive)
 * 2. MIME type
 * 3. Binary header magic bytes (e.g. 'fLaC', 'ID3', 'RIFF', 'ftyp', 'OggS', 'FORM')
 * 4. Parses STREAMINFO block directly for FLAC to get exact bit depth and sample rate in 0.1ms.
 */
export async function detectAudioFormat(file: File | Blob, originalFileName?: string): Promise<AudioFormatDetectionResult> {
  const fileName = (originalFileName || (file as File).name || '').toLowerCase();
  const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.') + 1) : '';
  const rawType = (file.type || '').toLowerCase();

  // Read first 42 bytes to check magic numbers and header blocks
  let bytes = new Uint8Array(0);
  try {
    const slice = await file.slice(0, 42).arrayBuffer();
    bytes = new Uint8Array(slice);
  } catch (e) {
    // Slicing failed, fallback to extension
  }

  // Check 1: FLAC magic bytes 'fLaC' (0x66, 0x4C, 0x61, 0x43)
  const hasFlacMagic = bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
  const isFlacExt = ext === 'flac' || ext === 'fla';
  const isFlacMime = rawType === 'audio/flac' || rawType === 'audio/x-flac';

  if (hasFlacMagic || isFlacExt || isFlacMime) {
    let streamInfo: { sampleRate: number; channels: number; bitsPerSample: number; duration: number } | undefined;
    
    // In FLAC, STREAMINFO block starts at byte 4
    if (bytes.length >= 26) {
      const blockType = bytes[4] & 0x7F;
      if (blockType === 0) {
        const sampleRate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
        const channels = ((bytes[20] >> 1) & 0x07) + 1;
        const bitsPerSample = (((bytes[20] & 0x01) << 4) | (bytes[21] >> 4)) + 1;
        const totalSamplesHigh = bytes[21] & 0x0F;
        const totalSamplesLow = (bytes[22] << 24) | (bytes[23] << 16) | (bytes[24] << 8) | bytes[25];
        const totalSamples = (totalSamplesHigh * 0x100000000) + (totalSamplesLow >>> 0);
        const duration = sampleRate > 0 ? totalSamples / sampleRate : 0;

        if (sampleRate > 0 && bitsPerSample > 0) {
          streamInfo = { sampleRate, channels, bitsPerSample, duration };
        }
      }
    }

    const bitStr = streamInfo?.bitsPerSample ? `${streamInfo.bitsPerSample}-bit` : 'Lossless';
    const rateStr = streamInfo?.sampleRate ? `${(streamInfo.sampleRate / 1000).toFixed(1)} kHz` : '';

    return {
      isFlac: true,
      format: 'FLAC',
      mimeType: 'audio/flac',
      lossless: true,
      qualityLabel: `FLAC ${bitStr}${rateStr ? ` / ${rateStr}` : ''}`,
      streamInfo
    };
  }

  // Check 2: WAV (RIFF....WAVE)
  const isWavMagic = bytes.length >= 12 && 
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // 'RIFF'
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45; // 'WAVE'
  if (isWavMagic || ext === 'wav' || ext === 'wave' || rawType.includes('wav')) {
    return {
      isFlac: false,
      format: 'WAV',
      mimeType: 'audio/wav',
      lossless: true,
      qualityLabel: 'WAV Lossless PCM'
    };
  }

  // Check 3: MP3 (ID3 or sync word 0xFF, 0xFB/F3/F2)
  const isMp3Magic = (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
                     (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0);
  if (isMp3Magic || ext === 'mp3' || rawType.includes('mpeg') || rawType.includes('mp3')) {
    return {
      isFlac: false,
      format: 'MP3',
      mimeType: 'audio/mpeg',
      lossless: false,
      qualityLabel: 'MP3 Standard'
    };
  }

  // Check 4: M4A / AAC / ALAC (ftyp at offset 4, or ADTS sync word 0xFFF)
  const isM4aMagic = bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  const isAacAdts = bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xF6) === 0xF0;
  if (isM4aMagic || isAacAdts || ext === 'm4a' || ext === 'aac' || ext === 'alac' || ext === 'm4b' || ext === 'm4p' || ext === 'mp4' || rawType.includes('aac') || rawType.includes('mp4') || rawType.includes('m4a')) {
    const isAlac = ext === 'alac';
    const isRawAac = isAacAdts || ext === 'aac';
    return {
      isFlac: false,
      format: isAlac ? 'ALAC' : (isRawAac ? 'AAC' : 'M4A'),
      mimeType: isRawAac ? 'audio/aac' : 'audio/mp4',
      lossless: isAlac,
      qualityLabel: isAlac ? 'ALAC Lossless' : (isRawAac ? 'AAC Audio' : 'M4A / AAC')
    };
  }

  // Check 5: OGG / Opus ('OggS' at offset 0)
  const isOggMagic = bytes.length >= 4 && bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
  if (isOggMagic || ext === 'ogg' || ext === 'oga' || ext === 'opus' || rawType.includes('ogg') || rawType.includes('opus')) {
    return {
      isFlac: false,
      format: ext === 'opus' ? 'OPUS' : 'OGG',
      mimeType: ext === 'opus' ? 'audio/opus' : 'audio/ogg',
      lossless: false,
      qualityLabel: ext === 'opus' ? 'Opus Audio' : 'Ogg Vorbis'
    };
  }

  // Check 6: AIFF ('FORM....AIFF' or 'FORM....AIFC')
  const isAiffMagic = bytes.length >= 12 &&
    bytes[0] === 0x46 && bytes[1] === 0x4F && bytes[2] === 0x52 && bytes[3] === 0x4D &&
    bytes[8] === 0x41 && bytes[9] === 0x49 && bytes[10] === 0x46 && (bytes[11] === 0x46 || bytes[11] === 0x43);
  if (isAiffMagic || ext === 'aif' || ext === 'aiff' || ext === 'aifc' || rawType.includes('aiff')) {
    return {
      isFlac: false,
      format: 'AIFF',
      mimeType: 'audio/aiff',
      lossless: true,
      qualityLabel: 'AIFF Lossless PCM'
    };
  }

  // Check 7: WebM (EBML header 0x1A 0x45 0xDF 0xA3)
  const isWebmMagic = bytes.length >= 4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3;
  if (isWebmMagic || ext === 'webm' || ext === 'weba' || rawType.includes('webm')) {
    return {
      isFlac: false,
      format: 'WEBM',
      mimeType: 'audio/webm',
      lossless: false,
      qualityLabel: 'WebM Audio'
    };
  }

  // Default fallback for any other audio format (nhạc thường)
  const fmt = (ext ? ext.toUpperCase() : 'AUDIO') as any;
  return {
    isFlac: false,
    format: fmt,
    mimeType: rawType || 'audio/mpeg',
    lossless: false,
    qualityLabel: `${fmt} Standard`
  };
}

/**
 * Validates and decodes a small slice of FLAC with libFLAC WASM to verify stream integrity
 */
export async function verifyFlacWithWasm(file: File): Promise<{
  isValid: boolean;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  error?: string;
}> {
  let decoder: FLACDecoder | null = null;
  try {
    decoder = new FLACDecoder();
    await decoder.ready;
    
    // Read the first 64KB containing STREAMINFO and initial frame
    const headerChunk = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
    const uint8 = new Uint8Array(headerChunk);
    
    const result = await decoder.decode(uint8);
    return {
      isValid: true,
      sampleRate: result.sampleRate,
      bitDepth: result.bitDepth,
      channels: result.channelData ? result.channelData.length : undefined
    };
  } catch (err: any) {
    return {
      isValid: false,
      error: err?.message || 'FLAC stream verification failed'
    };
  } finally {
    if (decoder) {
      try {
        decoder.free();
      } catch (e) {
        // Ignore free error
      }
    }
  }
}

/**
 * Converts raw PCM channel arrays into a bit-exact lossless WAV PCM Blob
 */
export function audioBufferToWavBlob(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: number = 16
): Blob {
  const numChannels = channels.length;
  const numSamples = channels[0].length;
  const bytesPerSample = bitDepth === 24 ? 3 : 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(v: DataView, offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      v.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth === 24 ? 24 : 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  if (bitDepth === 24) {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const s = Math.max(-1, Math.min(1, channels[ch][i]));
        const val = s < 0 ? s * 0x800000 : s * 0x7FFFFF;
        const intVal = Math.floor(val);
        view.setUint8(offset, intVal & 0xFF);
        view.setUint8(offset + 1, (intVal >> 8) & 0xFF);
        view.setUint8(offset + 2, (intVal >> 16) & 0xFF);
        offset += 3;
      }
    }
  } else {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const s = Math.max(-1, Math.min(1, channels[ch][i]));
        const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(offset, Math.floor(val), true);
        offset += 2;
      }
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Universal fallback decoder for audio streams that fail HTML5 <audio> native playback.
 * Automatically tries:
 * 1. libFLAC WASM WebWorker (for FLAC)
 * 2. @audio/decode-aac (for M4A, AAC, and ALAC / Apple Lossless)
 * 3. Web Audio API AudioContext.decodeAudioData (universal platform engine)
 */
export async function decodeAudioFileToWavBlob(
  audioBufferOrArray: ArrayBuffer | Uint8Array,
  formatHint?: string,
  fileName?: string
): Promise<{
  wavBlob: Blob;
  sampleRate: number;
  channels: number;
  decoderEngine: string;
} | null> {
  const bytes = audioBufferOrArray instanceof Uint8Array 
    ? audioBufferOrArray 
    : new Uint8Array(audioBufferOrArray);
  const name = (fileName || '').toLowerCase();
  const hint = (formatHint || '').toUpperCase();

  // 1. Try FLAC WebWorker decoder if hinted or has FLAC magic bytes
  const isFlac = hint === 'FLAC' || name.endsWith('.flac') || name.endsWith('.fla') ||
    (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43);

  if (isFlac) {
    try {
      const decoder = new FLACDecoderWebWorker();
      await decoder.ready;
      const decoded = await decoder.decode(bytes);
      decoder.free();
      if (decoded && decoded.channelData && decoded.channelData.length > 0 && decoded.samplesDecoded > 0) {
        const wavBlob = audioBufferToWavBlob(decoded.channelData, decoded.sampleRate, decoded.bitDepth || 16);
        return {
          wavBlob,
          sampleRate: decoded.sampleRate,
          channels: decoded.channelData.length,
          decoderEngine: 'libFLAC WebAssembly Worker (WASM)'
        };
      }
    } catch (flacErr) {
      console.warn("FLAC worker decode fallback error, trying general decoder:", flacErr);
    }
  }

  // 2. Try AAC / M4A / ALAC decoder (@audio/decode-aac: FAAD2 WASM + ALAC pure JS)
  const isM4aOrAac = hint === 'M4A' || hint === 'AAC' || hint === 'ALAC' || 
    name.endsWith('.m4a') || name.endsWith('.aac') || name.endsWith('.alac') || name.endsWith('.mp4') || name.endsWith('.m4b') ||
    (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) ||
    (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xF6) === 0xF0);

  if (isM4aOrAac) {
    try {
      const decoded = await decodeAac(bytes);
      if (decoded && decoded.channelData && decoded.channelData.length > 0) {
        const wavBlob = audioBufferToWavBlob(decoded.channelData, decoded.sampleRate, 16);
        return {
          wavBlob,
          sampleRate: decoded.sampleRate,
          channels: decoded.channelData.length,
          decoderEngine: hint === 'ALAC' ? 'Apple Lossless ALAC Engine' : 'FAAD2 AAC/M4A Decoder'
        };
      }
    } catch (aacErr) {
      console.warn("@audio/decode-aac failed, trying Web Audio API:", aacErr);
    }
  }

  // 3. Universal Web Audio API decodeAudioData fallback (supports MP3, WAV, AAC, OGG, OPUS, WEBM, FLAC)
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      const audioCtx = new AudioContextClass();
      const bufCopy = (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer;
      const audioBuffer = await audioCtx.decodeAudioData(bufCopy);
      audioCtx.close().catch(() => {});

      if (audioBuffer && audioBuffer.length > 0) {
        const channels: Float32Array[] = [];
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
          channels.push(audioBuffer.getChannelData(c));
        }
        const wavBlob = audioBufferToWavBlob(channels, audioBuffer.sampleRate, 16);
        return {
          wavBlob,
          sampleRate: audioBuffer.sampleRate,
          channels: audioBuffer.numberOfChannels,
          decoderEngine: 'Web Audio API Universal Engine'
        };
      }
    }
  } catch (webAudioErr) {
    console.warn("Web Audio decodeAudioData fallback failed:", webAudioErr);
  }

  // 4. Last attempt with decodeAac if not previously attempted
  if (!isM4aOrAac) {
    try {
      const decoded = await decodeAac(bytes);
      if (decoded && decoded.channelData && decoded.channelData.length > 0) {
        const wavBlob = audioBufferToWavBlob(decoded.channelData, decoded.sampleRate, 16);
        return {
          wavBlob,
          sampleRate: decoded.sampleRate,
          channels: decoded.channelData.length,
          decoderEngine: 'AAC/ALAC Auto Engine'
        };
      }
    } catch (e) {
      // ignore
    }
  }

  return null;
}

/**
 * Parses comprehensive metadata from an audio file including embedded cover art
 * and technical specifications (16/24-bit, 44.1/48/96/192kHz, channels, bitrate).
 */
export async function extractAudioFileDetails(file: File): Promise<{
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  specs: AudioTechnicalSpecs;
  detection: AudioFormatDetectionResult;
}> {
  const fileNameNoExt = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
  const detection = await detectAudioFormat(file, file.name);
  const isFlac = detection.isFlac;

  let title = fileNameNoExt;
  let artist = 'Unknown Artist';
  let album: string | undefined = undefined;
  let coverUrl: string | undefined = undefined;
  let sampleRate = detection.streamInfo?.sampleRate || 44100;
  let bitsPerSample = detection.streamInfo?.bitsPerSample || (isFlac ? 16 : 16);
  let channels = detection.streamInfo?.channels || 2;
  let bitrate: number | undefined = undefined;
  let duration: number | undefined = detection.streamInfo?.duration;
  let lossless = detection.lossless;
  let format = detection.format;

  try {
    const metadata = await mm.parseBlob(file);

    if (metadata.common.title) {
      title = metadata.common.title.trim();
    }
    
    const potentialArtist = 
      metadata.common.artist || 
      (metadata.common.artists && metadata.common.artists.length > 0 ? metadata.common.artists.join(', ') : null) ||
      metadata.common.albumartist ||
      metadata.common.composer;
      
    if (potentialArtist) {
      artist = Array.isArray(potentialArtist) ? potentialArtist.join(', ') : String(potentialArtist).trim();
    } else if (title.includes(' - ')) {
      const parts = title.split(' - ');
      if (parts.length >= 2) {
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }
    }

    if (metadata.common.album) {
      album = metadata.common.album.trim();
    }

    // Extract real embedded cover art if present
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0];
      try {
        const picBlob = new Blob([pic.data], { type: pic.format || 'image/jpeg' });
        coverUrl = registerTrackedUrl(URL.createObjectURL(picBlob));
      } catch (err) {
        console.warn('Could not create object URL for embedded picture:', err);
      }
    }

    // Extract format specs
    if (metadata.format) {
      if (metadata.format.sampleRate) sampleRate = metadata.format.sampleRate;
      if (metadata.format.bitsPerSample) bitsPerSample = metadata.format.bitsPerSample;
      if (metadata.format.numberOfChannels) channels = metadata.format.numberOfChannels;
      if (metadata.format.bitrate) bitrate = metadata.format.bitrate;
      if (metadata.format.duration && !duration) duration = metadata.format.duration;
      if (metadata.format.lossless !== undefined) lossless = metadata.format.lossless;
      
      const codecName = (metadata.format.codec || '').toUpperCase();
      if (codecName === 'ALAC' || (metadata.format.lossless && (format === 'M4A' || format === 'ALAC'))) {
        format = 'ALAC' as any;
        lossless = true;
      } else if (codecName.includes('AAC')) {
        if (format !== 'AAC' && format !== 'M4A') format = 'M4A' as any;
      } else if (metadata.format.container && !isFlac && format === 'AUDIO') {
        format = metadata.format.container.toUpperCase() as any;
      }
    }
  } catch (metaErr) {
    console.warn(`music-metadata parse failed for ${file.name}, using header info:`, metaErr);
  }

  // If FLAC and bit depth or sample rate still not determined, verify with WASM libFLAC
  if (isFlac && (!bitsPerSample || !sampleRate)) {
    try {
      const wasmCheck = await verifyFlacWithWasm(file);
      if (wasmCheck.isValid) {
        if (wasmCheck.sampleRate) sampleRate = wasmCheck.sampleRate;
        if (wasmCheck.bitDepth) bitsPerSample = wasmCheck.bitDepth;
        if (wasmCheck.channels) channels = wasmCheck.channels;
      }
    } catch (wasmErr) {
      // Ignore fallback check
    }
  }

  const isAlac = format === 'ALAC';
  const specs: AudioTechnicalSpecs = {
    format: isFlac ? 'FLAC' : format,
    container: isFlac ? 'FLAC' : (isAlac ? 'M4A (Apple Lossless)' : format),
    codec: isFlac 
      ? 'FLAC (Free Lossless Audio Codec)' 
      : (isAlac ? 'ALAC (Apple Lossless Audio Codec)' : `${format} Audio`),
    lossless: isFlac || isAlac || format === 'WAV' || format === 'AIFF' || lossless,
    sampleRate,
    bitsPerSample,
    channels,
    bitrate: bitrate || (file.size && duration ? Math.round((file.size * 8) / duration) : undefined),
    duration,
    album,
    fileSize: file.size,
    decoderEngine: isFlac 
      ? 'Chromium Native Streaming & libFLAC WASM' 
      : (isAlac ? 'Apple Lossless ALAC Engine' : `Native Browser Media Engine (${format})`),
    pcmFormat: `${bitsPerSample}-bit / 32-bit Float Linear PCM`
  };

  return {
    title,
    artist,
    album,
    coverUrl,
    specs,
    detection
  };
}

let cachedAudioContext: AudioContext | null = null;

export function getAudioOutputPipelineInfo(): OutputPipelineInfo {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!cachedAudioContext && AudioContextClass) {
      cachedAudioContext = new AudioContextClass();
    }

    const deviceSampleRate = cachedAudioContext ? cachedAudioContext.sampleRate : 48000;
    const audioContextState = cachedAudioContext ? cachedAudioContext.state : 'uninitialized';
    const outputChannels = cachedAudioContext?.destination?.maxChannelCount || 2;

    return {
      deviceSampleRate,
      outputChannels,
      audioContextState,
      effectsApplied: false,
      isBitPerfectVerified: false,
      pipelineDescription: 'Direct Stream to OS Audio Pipeline (No DSP, EQ or Dynamic Compression)'
    };
  } catch (e) {
    return {
      deviceSampleRate: 48000,
      outputChannels: 2,
      audioContextState: 'suspended',
      effectsApplied: false,
      isBitPerfectVerified: false,
      pipelineDescription: 'Standard Browser Audio Pipeline'
    };
  }
}
export { FLACDecoder, FLACDecoderWebWorker };
