// Simple Web Audio API synthesizer for sound effects

let audioCtx = null;

const getAudioContext = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume if suspended (browsers often suspend context until user interaction)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
};

export const playTone = (frequency, type, duration, vol, offset = 0) => {
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    const startTime = ctx.currentTime + offset;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startTime);
    
    // Prevent clicking by ramping up quickly then ramping down
    gainNode.gain.setValueAtTime(0.01, startTime);
    gainNode.gain.exponentialRampToValueAtTime(vol, startTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(startTime);
    oscillator.stop(startTime + duration);
  } catch (e) {
    console.error("Audio API not supported", e);
  }
};

export const playBuzzer = () => {
  // A dissonant, low frequency "buzz" sound, softened to a sine wave with lower volume
  playTone(150, 'sine', 0.6, 0.15, 0);
  playTone(140, 'sine', 0.8, 0.15, 0.1);
};

export const playSuccess = () => {
  // A bright "ding" or chime
  playTone(523.25, 'sine', 0.3, 0.3, 0); // C5
  playTone(659.25, 'sine', 0.5, 0.3, 0.15); // E5
  playTone(783.99, 'sine', 0.8, 0.3, 0.3); // G5
};
