import * as THREE from "three";

import { videoSeekTarget } from "../core/video-transport.js";

function mediaKind(item) {
  const declared = item?.mediaType ?? item?.media_type ?? item?.type;
  if (typeof declared === "string" && declared.startsWith("video")) {
    return "video";
  }
  if (typeof declared === "string" && declared.startsWith("image")) {
    return "image";
  }
  return /\.(mp4|webm)$/i.test(item?.path ?? "") ? "video" : "image";
}

export class MediaTexture {
  constructor() {
    this.texture = null;
    this.video = null;
    this.objectUrl = null;
    this.loadGeneration = 0;
  }

  async load(item, url, { autoplay = false } = {}) {
    const generation = ++this.loadGeneration;
    this.#releaseCurrent();
    const result = mediaKind(item) === "video"
      ? await this.#loadVideo(url)
      : await this.#loadImage(url);
    if (generation !== this.loadGeneration) {
      this.#releaseResult(result);
      return null;
    }
    this.texture = result.texture;
    this.video = result.media;
    if (autoplay && this.video) {
      try {
        await this.video.play();
      } catch (error) {
        if (generation === this.loadGeneration) {
          this.#releaseCurrent();
        }
        throw error;
      }
    }
    return result;
  }

  async #loadImage(url) {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    const naturalWidth = texture.image.naturalWidth;
    const naturalHeight = texture.image.naturalHeight;
    return {
      texture,
      aspect: naturalWidth / naturalHeight,
      naturalWidth,
      naturalHeight,
      width: naturalWidth,
      height: naturalHeight,
      media: null,
      type: "image",
    };
  }

  async #loadVideo(url) {
    const video = document.createElement("video");
    video.src = url;
    video.playsInline = true;
    video.preload = "metadata";
    video.loop = false;
    video.crossOrigin = "anonymous";

    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener(
        "error",
        () => reject(new Error("This video could not be decoded by the browser.")),
        { once: true },
      );
      video.load();
    });

    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return {
      texture,
      aspect: video.videoWidth / video.videoHeight,
      naturalWidth: video.videoWidth,
      naturalHeight: video.videoHeight,
      width: video.videoWidth,
      height: video.videoHeight,
      media: video,
      type: "video",
    };
  }

  play() {
    return this.video?.play() ?? Promise.resolve();
  }

  pause() {
    this.video?.pause();
  }

  /** True only while the element is actually advancing; an ended video reads as paused. */
  isPlaying() {
    return Boolean(this.video && !this.video.paused && !this.video.ended);
  }

  get currentTime() {
    return this.video?.currentTime ?? 0;
  }

  get duration() {
    return this.video?.duration ?? Number.NaN;
  }

  /**
   * Moves the video by a relative number of seconds, clamped to its bounds.
   * Returns the applied position, or null when no video can be seeked.
   */
  seekBy(deltaSeconds) {
    const video = this.video;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return null;
    const target = videoSeekTarget(video.currentTime, deltaSeconds, video.duration);
    if (target === null) return null;
    try {
      video.currentTime = target;
    } catch {
      return null;
    }
    return target;
  }

  dispose() {
    this.loadGeneration += 1;
    this.#releaseCurrent();
  }

  #releaseCurrent() {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
      this.video = null;
    }
    this.texture?.dispose();
    this.texture = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  #releaseResult(result) {
    if (result.media) {
      result.media.pause();
      result.media.removeAttribute("src");
      result.media.load();
    }
    result.texture.dispose();
  }
}
