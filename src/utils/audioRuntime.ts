// The audio context and its cached buffers share one owner. This module is
// independent of the store so muting does not import the playback graph.
let audioCtx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

const NOISE_BUFFER_S = 1;
const NOISE_CHANNELS = 1;

export const getAudioContext = async (): Promise<AudioContext> => {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  return audioCtx;
};

/** Release the audio hardware and buffers when sound is turned off. */
export const closeAudioContext = async (): Promise<void> => {
  if (audioCtx && audioCtx.state !== 'closed') {
    await audioCtx.close();
  }
  audioCtx = null;
  noiseBuffer = null;
};

/** One second of white noise, shared by every noise sound in this context. */
export const getNoiseBuffer = (ctx: AudioContext): AudioBuffer => {
  if (noiseBuffer) return noiseBuffer;
  const length = Math.floor(ctx.sampleRate * NOISE_BUFFER_S);
  const buffer = ctx.createBuffer(NOISE_CHANNELS, length, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
};
