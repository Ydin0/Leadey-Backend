/**
 * Minimal pure-JS WAV (RIFF/PCM) reader + a stereo → two-mono splitter.
 *
 * Twilio dual-channel call recordings (`record-from-answer-dual`) put each party
 * on a separate channel. By fetching the recording as a `.wav` (uncompressed
 * PCM) we can deinterleave the two channels and transcribe each one
 * independently — which gives perfect speaker separation with no diarization
 * service. No ffmpeg / native deps required.
 */

interface WavInfo {
  audioFormat: number; // 1 = PCM
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

function readWavHeader(buf: Buffer): WavInfo | null {
  if (buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, buf.length - body);
      break; // data is the last chunk we care about
    }
    // Chunks are word-aligned (pad to even length).
    offset = body + size + (size % 2);
  }

  if (!fmt || dataOffset < 0) return null;
  return { ...fmt, dataOffset, dataLength };
}

function buildMonoWav(samples: Buffer, sampleRate: number, bitsPerSample: number): Buffer {
  const byteRate = (sampleRate * bitsPerSample) / 8;
  const blockAlign = bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

/**
 * Split a stereo PCM WAV into two mono WAV buffers (channel 0 + channel 1).
 * Returns null when the input isn't a 2-channel PCM WAV we can split.
 */
export function splitStereoWav(buf: Buffer): { left: Buffer; right: Buffer; sampleRate: number } | null {
  const info = readWavHeader(buf);
  if (!info) return null;
  if (info.audioFormat !== 1) return null; // PCM only
  if (info.channels !== 2) return null;
  const bytesPerSample = info.bitsPerSample / 8;
  if (bytesPerSample < 1) return null;

  const frameSize = bytesPerSample * 2; // both channels
  const frames = Math.floor(info.dataLength / frameSize);
  const left = Buffer.alloc(frames * bytesPerSample);
  const right = Buffer.alloc(frames * bytesPerSample);

  for (let f = 0; f < frames; f++) {
    const src = info.dataOffset + f * frameSize;
    buf.copy(left, f * bytesPerSample, src, src + bytesPerSample);
    buf.copy(right, f * bytesPerSample, src + bytesPerSample, src + frameSize);
  }

  return {
    left: buildMonoWav(left, info.sampleRate, info.bitsPerSample),
    right: buildMonoWav(right, info.sampleRate, info.bitsPerSample),
    sampleRate: info.sampleRate,
  };
}
