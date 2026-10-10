import type { RosterEntry } from "./roster-codec.ts";
import type { RtcTransport } from "./rtc-transport.ts";
import { voiceGain, voiceSendOpen } from "./voice-range.ts";

/** Seconds a listener's gain takes to settle on a speaker's new distance (an exponential time constant), so a moving car never clicks. */
const GAIN_SMOOTHING_S = 0.05;
/** Seconds between two readings of every voice's level. */
const ANALYSIS_INTERVAL_S = 0.1;
/** Samples per level reading. */
const ANALYSER_WINDOW = 1024;
/** RMS of a level reading above which a voice counts as speaking (about −40 dBFS). */
const SPEAKING_RMS = 0.01;
/** Seconds a voice keeps counting as speaking after its last loud reading, so gaps between words do not flicker the indicator. */
const SPEAKING_HOLD_S = 0.3;

/** A point in the world; a three.js `Vector3` fits. */
interface Position {
  x: number;
  y: number;
  z: number;
}

/** Where the listener and the speakers are: netplay's car table. */
interface VoiceWorld {
  /** This peer's id on the transport (a roster lists every seated player, this one too). */
  selfId(): string;
  /** The car this peer drives (the listener); −1 before the host seats it. */
  localCar(): number;
  /** Car `car`'s world position, null when no such car is drawn. */
  carPosition(car: number): Position | null;
}

/** One remote player as the voice panel shows it. */
export interface VoicePeerStatus {
  id: string;
  /** The car the peer drives, −1 until the host's roster says. */
  car: number;
  /** This listener's own volume for the peer, 0-1, and its mute. */
  volume: number;
  muted: boolean;
  speaking: boolean;
  /** Within voice range: this browser sends the peer its microphone and hears the peer's. */
  inRange: boolean;
}

/** What the UI reads (`useSyncExternalStore`): a new object whenever anything in it changed. */
export interface VoiceStatus {
  /** This browser has what voice needs (a microphone API, so a secure page). */
  supported: boolean;
  on: boolean;
  starting: boolean;
  muted: boolean;
  error: string | null;
  /** This player's own microphone is picking up speech. */
  speaking: boolean;
  peers: readonly VoicePeerStatus[];
}

interface PeerNodes {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  /** Chromium delivers a remote WebRTC stream to Web Audio only while it is also attached to a media element; this one is muted. */
  keepAlive: HTMLAudioElement;
}

interface VoicePeer {
  id: string;
  /** The car the host's roster seats the peer in; −1 until it says. */
  car: number;
  stream: MediaStream | null;
  volume: number;
  muted: boolean;
  sendOpen: boolean;
  speakingHold: number;
  nodes: PeerNodes | null;
}

/** The audio graph and microphone, alive from the opt-in click to leaving. */
interface Session {
  context: AudioContext;
  /** Every peer's voice mixes here; the sink element plays it, on the chosen output device. */
  master: MediaStreamAudioDestinationNode;
  sink: HTMLAudioElement;
  microphone: MediaStream;
  track: MediaStreamTrack;
  selfSource: MediaStreamAudioSourceNode;
  selfAnalyser: AnalyserNode;
  selfHold: number;
}

type SinkElement = HTMLAudioElement & { setSinkId(sinkId: string): Promise<void> };

/** Whether this browser can send audio to a chosen output device (`HTMLMediaElement.setSinkId`: not Chrome Android). */
export function outputChoiceSupported(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

function describeVoiceError(err: unknown): string {
  if (!(err instanceof DOMException)) return err instanceof Error ? err.message : String(err);
  if (err.name === "NotAllowedError") return "The microphone is blocked: allow it in the browser's site settings";
  if (err.name === "NotFoundError") return "No microphone found";
  return `${err.name}: ${err.message}`;
}

function distanceBetween(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Opt-in proximity voice on the WebRTC mesh (docs/MULTIPLAYER.md "Voice"). Each pair's connection carries one audio
 * transceiver from the start, so opting in only attaches the microphone track. A speaker is heard at the distance gain
 * (`voiceGain`) of the cars' world positions and its browser stops sending to listeners beyond `VOICE_MAX_RANGE_M`.
 */
export class Voice {
  private readonly world: VoiceWorld;
  private transport: RtcTransport | null = null;
  private readonly peers = new Map<string, VoicePeer>();
  private readonly listeners = new Set<() => void>();
  private session: Session | null = null;
  private starting = false;
  private muted = false;
  private error: string | null = null;
  private inputId = "";
  private outputId = "";
  private analysisClock = 0;
  private readonly samples = new Float32Array(ANALYSER_WINDOW);
  private changed = false;
  private view: VoiceStatus = { supported: false, on: false, starting: false, muted: false, error: null, speaking: false, peers: [] };

  constructor(world: VoiceWorld) {
    this.world = world;
  }

  /** The `useSyncExternalStore` pair. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): VoiceStatus => this.view;

  /** A new room's WebRTC transport: its remote audio arrives here. */
  bind(transport: RtcTransport): void {
    this.transport = transport;
    transport.onRemoteAudio = (from, stream) => this.takeStream(from, stream);
    this.publish();
  }

  /** Leaving the room: the microphone is released and every peer forgotten. */
  unbind(): void {
    this.stop();
    for (const peer of this.peers.values()) this.dropNodes(peer);
    this.peers.clear();
    if (this.transport) this.transport.onRemoteAudio = null;
    this.transport = null;
    this.publish();
  }

  /** The host's roster: which car each other player drives. A listed player without a voice stream and no seat any more is forgotten. */
  setRoster(entries: readonly RosterEntry[]): void {
    const seated = new Map<string, number>();
    for (const entry of entries) seated.set(entry.peer, entry.car);
    seated.delete(this.world.selfId());
    for (const peer of this.peers.values()) {
      peer.car = seated.get(peer.id) ?? -1;
      if (peer.car < 0 && !peer.stream) this.peers.delete(peer.id);
    }
    for (const [id, car] of seated) this.peerOf(id).car = car;
    this.publish();
  }

  /** The opt-in click: asks for the microphone and joins the room's voice on the chosen devices ("" is the default). */
  async start(devices: { input: string; output: string }): Promise<void> {
    if (this.session || this.starting || !this.transport || !this.view.supported) return;
    this.inputId = devices.input;
    this.outputId = devices.output;
    this.starting = true;
    this.error = null;
    this.publish();
    try {
      const session = await this.openSession();
      this.session = session;
      for (const peer of this.peers.values()) this.buildNodes(peer, session);
    } catch (err) {
      this.error = describeVoiceError(err);
    }
    this.starting = false;
    this.publish();
  }

  /** Leaves voice: nothing is sent, the microphone is released. */
  stop(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    for (const peer of this.peers.values()) {
      this.dropNodes(peer);
      peer.sendOpen = false;
      peer.speakingHold = 0;
      this.transport?.sendAudio(peer.id, null);
    }
    session.selfSource.disconnect();
    for (const track of session.microphone.getTracks()) track.stop();
    session.sink.srcObject = null;
    session.sink.remove();
    void session.context.close();
    this.publish();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.publish();
  }

  setPeerVolume(id: string, volume: number): void {
    this.peerOf(id).volume = Math.min(1, Math.max(0, volume));
    this.publish();
  }

  setPeerMuted(id: string, muted: boolean): void {
    this.peerOf(id).muted = muted;
    this.publish();
  }

  /** A new microphone ("" the default); while voice is on it takes over at once. */
  async setInputDevice(id: string): Promise<void> {
    this.inputId = id;
    const session = this.session;
    if (!session) return;
    try {
      this.swapMicrophone(session, await navigator.mediaDevices.getUserMedia({ audio: this.microphoneConstraints() }));
    } catch (err) {
      this.error = describeVoiceError(err);
    }
    this.publish();
  }

  /** A new output device ("" the default); while voice is on it takes over at once. */
  async setOutputDevice(id: string): Promise<void> {
    this.outputId = id;
    if (this.session) await this.routeSink(this.session.sink);
    this.publish();
  }

  /** Once per rendered frame: each speaker's gain and whether it is sent to follow the cars, and the speaking indicators. */
  update(dt: number): void {
    const session = this.session;
    const transport = this.transport;
    if (!session || !transport) return;
    const listener = this.world.carPosition(this.world.localCar());
    const now = session.context.currentTime;
    for (const peer of this.peers.values()) this.steer(peer, listener, now, session, transport);
    this.analysisClock += dt;
    if (this.analysisClock >= ANALYSIS_INTERVAL_S) {
      this.analysisClock = 0;
      this.readLevels(session);
    }
    if (this.changed) this.publish();
  }

  private peerOf(id: string): VoicePeer {
    let peer = this.peers.get(id);
    if (!peer) {
      peer = { id, car: -1, stream: null, volume: 1, muted: false, sendOpen: false, speakingHold: 0, nodes: null };
      this.peers.set(id, peer);
    }
    return peer;
  }

  private steer(peer: VoicePeer, listener: Position | null, now: number, session: Session, transport: RtcTransport): void {
    const speaker = peer.car >= 0 ? this.world.carPosition(peer.car) : null;
    const distance = listener && speaker ? distanceBetween(listener, speaker) : Infinity;
    const open = voiceSendOpen(distance, peer.sendOpen);
    if (open !== peer.sendOpen) this.changed = true;
    peer.sendOpen = open;
    transport.sendAudio(peer.id, open && !this.muted ? session.track : null);
    peer.nodes?.gain.gain.setTargetAtTime(peer.muted ? 0 : peer.volume * voiceGain(distance), now, GAIN_SMOOTHING_S);
  }

  private readLevels(session: Session): void {
    for (const peer of this.peers.values()) {
      if (!peer.nodes) continue;
      const before = peer.speakingHold > 0;
      peer.speakingHold = this.holdAfter(peer.speakingHold, peer.nodes.analyser);
      if (before !== peer.speakingHold > 0) this.changed = true;
    }
    const selfWasSpeaking = session.selfHold > 0;
    session.selfHold = this.muted ? 0 : this.holdAfter(session.selfHold, session.selfAnalyser);
    if (selfWasSpeaking !== session.selfHold > 0) this.changed = true;
  }

  private holdAfter(hold: number, analyser: AnalyserNode): number {
    analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i]! * this.samples[i]!;
    return Math.sqrt(sum / this.samples.length) > SPEAKING_RMS ? SPEAKING_HOLD_S : Math.max(0, hold - ANALYSIS_INTERVAL_S);
  }

  private takeStream(from: string, stream: MediaStream | null): void {
    if (!stream) {
      const gone = this.peers.get(from);
      if (gone) this.dropNodes(gone);
      this.peers.delete(from);
      this.publish();
      return;
    }
    const peer = this.peerOf(from);
    peer.stream = stream;
    if (this.session) this.buildNodes(peer, this.session);
    this.publish();
  }

  private buildNodes(peer: VoicePeer, session: Session): void {
    this.dropNodes(peer);
    if (!peer.stream) return;
    const { context, master } = session;
    const source = context.createMediaStreamSource(peer.stream);
    const gain = context.createGain();
    gain.gain.value = 0;
    const analyser = context.createAnalyser();
    analyser.fftSize = ANALYSER_WINDOW;
    source.connect(gain);
    gain.connect(master);
    gain.connect(analyser);
    const keepAlive = new Audio();
    keepAlive.muted = true;
    keepAlive.autoplay = true;
    keepAlive.srcObject = peer.stream;
    document.body.append(keepAlive);
    peer.nodes = { source, gain, analyser, keepAlive };
  }

  private dropNodes(peer: VoicePeer): void {
    const nodes = peer.nodes;
    if (!nodes) return;
    nodes.source.disconnect();
    nodes.gain.disconnect();
    nodes.analyser.disconnect();
    nodes.keepAlive.srcObject = null;
    nodes.keepAlive.remove();
    peer.nodes = null;
  }

  private microphoneConstraints(): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (this.inputId) constraints.deviceId = { ideal: this.inputId };
    return constraints;
  }

  private async openSession(): Promise<Session> {
    const context = new AudioContext();
    let microphone: MediaStream | null = null;
    try {
      await context.resume();
      microphone = await navigator.mediaDevices.getUserMedia({ audio: this.microphoneConstraints() });
      const master = context.createMediaStreamDestination();
      const sink = new Audio();
      sink.srcObject = master.stream;
      document.body.append(sink);
      await this.routeSink(sink);
      await sink.play();
      const track = microphone.getAudioTracks()[0]!;
      const selfSource = context.createMediaStreamSource(microphone);
      const selfAnalyser = context.createAnalyser();
      selfAnalyser.fftSize = ANALYSER_WINDOW;
      selfSource.connect(selfAnalyser);
      track.onended = () => this.microphoneLost();
      return { context, master, sink, microphone, track, selfSource, selfAnalyser, selfHold: 0 };
    } catch (err) {
      for (const track of microphone?.getTracks() ?? []) track.stop();
      await context.close();
      throw err;
    }
  }

  private async routeSink(sink: HTMLAudioElement): Promise<void> {
    if (!outputChoiceSupported()) return;
    try {
      await (sink as SinkElement).setSinkId(this.outputId);
    } catch (err) {
      console.warn("[voice] setSinkId failed:", err);
      this.error = "That output device is unavailable: using the default";
    }
  }

  private swapMicrophone(session: Session, microphone: MediaStream): void {
    session.selfSource.disconnect();
    for (const track of session.microphone.getTracks()) track.stop();
    session.microphone = microphone;
    session.track = microphone.getAudioTracks()[0]!;
    session.track.onended = () => this.microphoneLost();
    session.selfSource = session.context.createMediaStreamSource(microphone);
    session.selfSource.connect(session.selfAnalyser);
  }

  private microphoneLost(): void {
    this.stop();
    this.error = "The microphone disconnected";
    this.publish();
  }

  private publish(): void {
    this.changed = false;
    const session = this.session;
    this.view = {
      supported: this.transport !== null && typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
      on: session !== null,
      starting: this.starting,
      muted: this.muted,
      error: this.error,
      speaking: (session?.selfHold ?? 0) > 0,
      peers: [...this.peers.values()].map((peer) => ({
        id: peer.id,
        car: peer.car,
        volume: peer.volume,
        muted: peer.muted,
        speaking: peer.speakingHold > 0,
        inRange: peer.sendOpen,
      })),
    };
    for (const listener of this.listeners) listener();
  }
}
