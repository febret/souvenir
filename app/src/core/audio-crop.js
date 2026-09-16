function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function audioBufferToWav(audioBuffer) {
  const { numberOfChannels, sampleRate, length } = audioBuffer;
  const bytesPerSample = 2;
  const blockAlign = numberOfChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let index = 0; index < length; index += 1) {
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const sample = clamp(audioBuffer.getChannelData(channel)[index] || 0, -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function cropAudioBuffer(audioBuffer, startSeconds, endSeconds, context) {
  const { start, end } = normalizeCrop(startSeconds, endSeconds, audioBuffer.duration);
  const length = Math.floor(Math.max(0, end - start) * audioBuffer.sampleRate);
  const factory = context ?? audioBuffer.context;
  if (!factory || typeof factory.createBuffer !== "function") {
    throw new Error("This browser can not apply audio trimming.");
  }
  const target = factory.createBuffer(
    audioBuffer.numberOfChannels,
    length,
    audioBuffer.sampleRate,
  );
  const offsetSamples = Math.floor(start * audioBuffer.sampleRate);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const source = audioBuffer.getChannelData(channel);
    const dest = target.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      dest[index] = source[offsetSamples + index] ?? 0;
    }
  }
  return target;
}

export function normalizeCrop(startSeconds, endSeconds, duration) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  const start = clamp(Number(startSeconds) || 0, 0, safeDuration);
  const end =
    Number.isFinite(Number(endSeconds)) && Number(endSeconds) >= 0
      ? clamp(Number(endSeconds), 0, safeDuration)
      : safeDuration;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function timeLabel(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00.0";
  }
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  const tenths = Math.floor((seconds - whole) * 10);
  return `${minutes}:${String(remainder).padStart(2, "0")}.${tenths}`;
}
