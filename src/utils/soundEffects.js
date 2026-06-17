// Simple Web Audio API synthesizer for sound effects

const playTone = (frequency, type, duration, vol) => {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    
    gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.start();
    oscillator.stop(audioCtx.currentTime + duration);
  } catch (e) {
    console.error("Audio API not supported", e);
  }
};

export const playBuzzer = () => {
  // A dissonant, low frequency "buzz" sound
  playTone(150, 'sawtooth', 0.6, 0.5);
  setTimeout(() => playTone(140, 'sawtooth', 0.8, 0.5), 100);
};

export const playSuccess = () => {
  // A bright "ding" or chime
  playTone(523.25, 'sine', 0.3, 0.3); // C5
  setTimeout(() => playTone(659.25, 'sine', 0.5, 0.3), 150); // E5
  setTimeout(() => playTone(783.99, 'sine', 0.8, 0.3), 300); // G5
};
