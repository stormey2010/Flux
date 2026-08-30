import { CheckIcon, MicIcon } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event & { readonly error?: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export interface ComposerSpeechButtonHandle {
  /** Stop recognition and synchronously add any currently displayed words. */
  finish: () => void;
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const browser = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}

/**
 * A local Chromium speech-recognition control. The microphone stays active
 * until the user presses the checkmark; completed phrases are forwarded as
 * soon as the browser recognizes them so sending cannot race the transcript.
 */
export const ComposerSpeechButton = forwardRef<
  ComposerSpeechButtonHandle,
  {
    readonly disabled?: boolean;
    readonly onTranscript: (text: string) => void;
  }
>(function ComposerSpeechButton({ disabled = false, onTranscript }, ref) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const interimTranscriptRef = useRef("");
  const ignoreResultsRef = useRef(false);
  const shouldKeepListeningRef = useRef(false);
  const restartTimerRef = useRef<number | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const [isListening, setIsListening] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAvailable] = useState(
    () => typeof window !== "undefined" && getSpeechRecognitionConstructor() !== null,
  );

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(
    () => () => {
      shouldKeepListeningRef.current = false;
      if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  const finishListening = useCallback(() => {
    const recognition = recognitionRef.current;
    shouldKeepListeningRef.current = false;
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (!recognition) {
      setIsListening(false);
      return;
    }
    // A browser may still hold the last words as an interim result when the
    // user presses Send. Commit those words now so the outgoing draft has
    // them, and ignore the duplicate final event emitted by stop().
    ignoreResultsRef.current = true;
    const interim = interimTranscriptRef.current.trim();
    interimTranscriptRef.current = "";
    if (interim.length > 0) onTranscriptRef.current(interim);
    try {
      recognition.stop();
    } catch {
      recognition.abort();
    }
  }, []);

  useImperativeHandle(ref, () => ({ finish: finishListening }), [finishListening, ref]);

  const toggleListening = useCallback(() => {
    if (disabled || !isAvailable) return;
    if (recognitionRef.current) {
      finishListening();
      return;
    }

    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) return;
    setErrorMessage(null);

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    shouldKeepListeningRef.current = true;
    ignoreResultsRef.current = false;
    interimTranscriptRef.current = "";
    recognition.onresult = (event) => {
      if (ignoreResultsRef.current) return;
      let completed = "";
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) completed += result[0].transcript;
        else interim += result?.[0]?.transcript ?? "";
      }
      const text = completed.trim();
      interimTranscriptRef.current = interim.trim();
      if (text.length > 0) {
        // Forward final phrases immediately. This keeps the draft current even
        // when the user presses Send before the recognition session has ended.
        onTranscriptRef.current(text);
      }
    };
    recognition.onerror = (event) => {
      const code = event.error;
      shouldKeepListeningRef.current = false;
      setErrorMessage(
        code === "not-allowed" || code === "service-not-allowed"
          ? "Microphone access was denied"
          : code === "audio-capture"
            ? "No microphone was found"
            : code === "network"
              ? "Speech service is unavailable"
              : "Could not start dictation",
      );
    };
    recognition.onend = () => {
      if (shouldKeepListeningRef.current && !ignoreResultsRef.current) {
        // Speech services can end a continuous session after a pause or a
        // transient network handoff. Reconnect without changing the UI state.
        restartTimerRef.current = window.setTimeout(() => {
          restartTimerRef.current = null;
          if (!shouldKeepListeningRef.current || recognitionRef.current !== recognition) return;
          try {
            recognition.start();
          } catch {
            shouldKeepListeningRef.current = false;
            recognitionRef.current = null;
            setIsListening(false);
          }
        }, 150);
        return;
      }
      recognitionRef.current = null;
      setIsListening(false);
      interimTranscriptRef.current = "";
      ignoreResultsRef.current = false;
    };
    recognitionRef.current = recognition;
    setIsListening(true);
    try {
      recognition.start();
    } catch {
      shouldKeepListeningRef.current = false;
      recognitionRef.current = null;
      setIsListening(false);
    }
  }, [disabled, finishListening, isAvailable]);

  const label = isListening ? "Finish dictation and add text" : "Start dictation";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors enabled:cursor-pointer hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 sm:w-8",
              isListening && "border-message-action/50 bg-message-action/10 text-message-action",
              !isAvailable && "cursor-not-allowed opacity-40",
            )}
            onClick={toggleListening}
            disabled={disabled || !isAvailable}
            aria-label={label}
          />
        }
      >
        {isListening ? (
          <span className="flex items-end gap-0.5" aria-hidden="true">
            <span className="h-2 w-0.5 animate-pulse rounded-full bg-current" />
            <span className="h-3 w-0.5 animate-pulse rounded-full bg-current [animation-delay:120ms]" />
            <span className="h-1.5 w-0.5 animate-pulse rounded-full bg-current [animation-delay:240ms]" />
            <CheckIcon className="ml-0.5 size-3.5" strokeWidth={2.4} />
          </span>
        ) : (
          <MicIcon className="size-3.5" aria-hidden="true" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {isListening
          ? "Finish and add dictation"
          : isAvailable
            ? (errorMessage ?? "Dictate message")
            : "Speech recognition is unavailable"}
      </TooltipPopup>
    </Tooltip>
  );
});
