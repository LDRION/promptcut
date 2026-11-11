declare module "music-tempo" {
  /** Tempo + beat-grid estimator over decoded mono audio samples. */
  export default class MusicTempo {
    constructor(audioData: ArrayLike<number>, params?: Record<string, unknown>);
    /** Estimated tempo in BPM (string in the lib). */
    tempo: string | number;
    /** Beat times in seconds. */
    beats: number[];
    /** Onset/spectral-flux times in seconds. */
    events?: number[];
    tempoCount?: Record<string, number>;
  }
}
