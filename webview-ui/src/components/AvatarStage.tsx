import { useEffect, useRef, useState } from "react";

export type AvatarEvent =
  | { seq: number; kind: "begin" }
  | { seq: number; kind: "chunk"; chunkType: number; data: string }
  | { seq: number; kind: "end" }
  | { seq: number; kind: "stop" };

interface Props {
  image: string;
  name: string;
  mode: "text" | "voice" | "avatar";
  event?: AvatarEvent;
}

const FPS = 25;

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function AvatarStage({ image, name, mode, event }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<AudioContext>();
  const audioHeadRef = useRef(0);
  const audioQueueRef = useRef<Uint8Array[]>([]);
  const frameQueueRef = useRef<Blob[]>([]);
  const renderingRef = useRef(false);
  const waitingForFrameRef = useRef(false);
  const generationRef = useRef(0);
  const [speaking, setSpeaking] = useState(false);
  const [needsAudioClick, setNeedsAudioClick] = useState(false);

  const ensureAudio = () => {
    let context = audioRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContext();
      audioRef.current = context;
      audioHeadRef.current = context.currentTime;
    }
    if (context.state === "suspended") {
      setNeedsAudioClick(true);
    } else {
      setNeedsAudioClick(false);
    }
    return context;
  };

  const unlockAudio = () => {
    const context = ensureAudio();
    void context.resume().then(() => setNeedsAudioClick(context.state !== "running"));
  };

  const scheduleAudio = async (wav: Uint8Array) => {
    try {
      const context = ensureAudio();
      const buffer = await context.decodeAudioData(Uint8Array.from(wav).buffer);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const start = Math.max(audioHeadRef.current, context.currentTime + 0.01);
      source.start(start);
      audioHeadRef.current = start + buffer.duration;
    } catch {
      // One malformed chunk should not stop the remaining response.
    }
  };

  const renderFrames = () => {
    if (renderingRef.current || mode !== "avatar") return;
    renderingRef.current = true;
    const generation = generationRef.current;
    const startedAt = performance.now();
    let index = 0;
    const draw = () => {
      if (generation !== generationRef.current || mode !== "avatar") {
        renderingRef.current = false;
        return;
      }
      const queue = frameQueueRef.current;
      if (!queue.length) {
        renderingRef.current = false;
        return;
      }
      const target = Math.floor((performance.now() - startedAt) / (1000 / FPS));
      while (index < target && queue.length > 1) {
        queue.shift();
        index += 1;
      }
      const frame = queue.shift();
      if (!frame) return;
      index += 1;
      const url = URL.createObjectURL(frame);
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (canvas && context) {
          canvas.width = img.width;
          canvas.height = img.height;
          context.drawImage(img, 0, 0);
        }
        URL.revokeObjectURL(url);
        const nextAt = startedAt + index * (1000 / FPS);
        window.setTimeout(draw, Math.max(0, nextAt - performance.now()));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        window.setTimeout(draw, 0);
      };
      img.src = url;
    };
    draw();
  };

  useEffect(() => {
    if (!event) return;
    if (event.kind === "begin") {
      generationRef.current += 1;
      frameQueueRef.current = [];
      audioQueueRef.current = [];
      waitingForFrameRef.current = mode === "avatar";
      renderingRef.current = false;
      const context = ensureAudio();
      audioHeadRef.current = context.currentTime;
      setSpeaking(true);
      return;
    }
    if (event.kind === "stop") {
      generationRef.current += 1;
      frameQueueRef.current = [];
      audioQueueRef.current = [];
      renderingRef.current = false;
      setSpeaking(false);
      return;
    }
    if (event.kind === "end") {
      for (const wav of audioQueueRef.current.splice(0)) void scheduleAudio(wav);
      waitingForFrameRef.current = false;
      const context = audioRef.current;
      const remaining = context
        ? Math.max(0, (audioHeadRef.current - context.currentTime) * 1000)
        : 0;
      const generation = generationRef.current;
      window.setTimeout(() => {
        if (generation === generationRef.current) setSpeaking(false);
      }, remaining + 250);
      return;
    }

    const payload = bytesFromBase64(event.data);
    if (event.chunkType === 0) {
      if (waitingForFrameRef.current) audioQueueRef.current.push(payload);
      else void scheduleAudio(payload);
    } else if (event.chunkType === 1 && mode === "avatar") {
      if (waitingForFrameRef.current) {
        waitingForFrameRef.current = false;
        for (const wav of audioQueueRef.current.splice(0)) void scheduleAudio(wav);
      }
      frameQueueRef.current.push(new Blob([Uint8Array.from(payload).buffer], { type: "image/jpeg" }));
      renderFrames();
    }
  }, [event?.seq]);

  useEffect(() => {
    if (mode === "text") {
      generationRef.current += 1;
      setSpeaking(false);
    }
  }, [mode]);

  if (mode !== "avatar") {
    return (
      <div className={`voice-state ${speaking ? "speaking" : ""}`}>
        {mode === "voice" ? (speaking ? "● speaking" : "voice ready") : "text only"}
        {mode === "voice" && needsAudioClick ? (
          <button type="button" onClick={unlockAudio}>音声を有効化</button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`avatar-stage ${speaking ? "speaking" : ""}`} onPointerDown={unlockAudio}>
      <img className="avatar-still" src={image} alt={name} />
      <canvas ref={canvasRef} className={speaking ? "avatar-live" : "avatar-live hidden"} />
      <span className="avatar-pulse" aria-hidden="true" />
      {needsAudioClick ? (
        <button type="button" className="avatar-unmute" onClick={unlockAudio}>音声を有効化</button>
      ) : null}
    </div>
  );
}
