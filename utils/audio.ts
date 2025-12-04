import { Blob } from '@google/genai';

export const PCM_SAMPLE_RATE_INPUT = 16000;
export const PCM_SAMPLE_RATE_OUTPUT = 24000;

export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function createPcmBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767)
    let s = Math.max(-1, Math.min(1, data[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return {
    data: arrayBufferToBase64(int16.buffer),
    mimeType: `audio/pcm;rate=${PCM_SAMPLE_RATE_INPUT}`,
  };
}

/**
 * Downsamples audio buffer from any source rate to 16000Hz required by Gemini.
 * Uses linear interpolation.
 */
export function downsampleTo16k(buffer: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === PCM_SAMPLE_RATE_INPUT) {
    return buffer;
  }

  const ratio = inputSampleRate / PCM_SAMPLE_RATE_INPUT;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  
  for (let i = 0; i < newLength; i++) {
    const originalIndex = i * ratio;
    const index1 = Math.floor(originalIndex);
    const index2 = Math.min(index1 + 1, buffer.length - 1);
    const fraction = originalIndex - index1;
    
    // Linear interpolation
    result[i] = buffer[index1] * (1 - fraction) + buffer[index2] * fraction;
  }
  return result;
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = PCM_SAMPLE_RATE_OUTPUT,
  numChannels: number = 1
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}