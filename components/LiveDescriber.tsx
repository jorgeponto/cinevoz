import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Type, Modality } from '@google/genai';
import { Mic, MicOff, Film, Plus, Play, Trash2, StopCircle, Volume2, Loader2, Activity, Settings, FileAudio, RefreshCw, ArrowLeft, FileText, CheckCircle, Pause, Keyboard, Zap, X, Terminal, BrainCircuit, Waveform, Lock, Unlock, Megaphone } from 'lucide-react';
import { createPcmBlob, downsampleTo16k, base64ToUint8Array, decodeAudioData } from '../utils/audio';
import { parseSRT, formatTime, SrtEntry } from '../utils/srt';
import { AudioMatcher, MatchResult } from '../utils/audioMatcher';
import AudioVisualizer from './AudioVisualizer';

// --- Types ---

interface Movie {
  id: string;
  title: string;
  srtEntries: SrtEntry[];
  referenceAudioName: string;
  referenceAudioFile: File | null; 
}

interface LiveDescriberProps {
  apiKey: string;
}

interface AudioDevice {
    deviceId: string;
    label: string;
}

// --- Component ---

const LiveDescriber: React.FC<LiveDescriberProps> = ({ apiKey }) => {
  // UI State
  const [view, setView] = useState<'library' | 'studio'>('library');
  const [movies, setMovies] = useState<Movie[]>([]);
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  
  // Creation State
  const [newMovieTitle, setNewMovieTitle] = useState('');
  const [tempSrt, setTempSrt] = useState<SrtEntry[]>([]);
  const [tempAudioName, setTempAudioName] = useState<string>('');
  const [tempAudioFile, setTempAudioFile] = useState<File | null>(null);

  // Audio Config State
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [preFlightAnalyser, setPreFlightAnalyser] = useState<AnalyserNode | null>(null);
  const [isPreFlightTesting, setIsPreFlightTesting] = useState(false);
  
  // Studio Audio State
  const [studioStream, setStudioStream] = useState<MediaStream | null>(null);
  const [studioAnalyser, setStudioAnalyser] = useState<AnalyserNode | null>(null);
  const [studioVolume, setStudioVolume] = useState<number>(0);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [audioContextState, setAudioContextState] = useState<string>('inactive');
  
  // Reference Audio State
  const [refAudioDuration, setRefAudioDuration] = useState(0);
  const [refAnalyser, setRefAnalyser] = useState<AnalyserNode | null>(null);
  const [isPlayingRef, setIsPlayingRef] = useState(false); 
  
  // Mathematical Sync State
  const [audioMatcher] = useState(() => new AudioMatcher());
  const [isProcessingMatrix, setIsProcessingMatrix] = useState(false);
  const [isSyncActive, setIsSyncActive] = useState(false);
  const [syncConfidence, setSyncConfidence] = useState(0);
  const [lastSyncUpdate, setLastSyncUpdate] = useState<string>('');
  const [isLocked, setIsLocked] = useState(false);

  // AI State (Optional/Debug)
  const [aiDebugLog, setAiDebugLog] = useState<string[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false); 
  const [currentMovieTime, setCurrentMovieTime] = useState(0);
  const [lastSpokenText, setLastSpokenText] = useState<string>('');
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  
  // Refs
  const preFlightContextRef = useRef<AudioContext | null>(null);
  
  // Studio Refs
  const studioContextRef = useRef<AudioContext | null>(null);
  const studioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const studioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const studioGainRef = useRef<GainNode | null>(null);
  
  // Reference Audio Refs
  const refAudioElementRef = useRef<HTMLAudioElement | null>(null);
  const refSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const highPrecisionLoopRef = useRef<number | undefined>(undefined);

  // Sync Logic Refs
  const processedEntryIds = useRef<Set<string>>(new Set());
  const scriptContainerRef = useRef<HTMLDivElement | null>(null); // NEW: Container Ref
  const activeSrtRef = useRef<HTMLDivElement | null>(null);
  const currentMovieTimeRef = useRef<number>(0); 
  const liveBufferRef = useRef<Float32Array[]>([]); 
  const syncIntervalRef = useRef<number | undefined>(undefined);
  
  // Sync Stabilization Refs
  const potentialSyncRef = useRef<{time: number, timestamp: number, count: number} | null>(null);
  const syncLockUntilRef = useRef<number>(0); 
  const isGlobalScanNeeded = useRef<boolean>(true); // Start needing a global scan

  // --- Init ---

  useEffect(() => {
    const getDevices = async () => {
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices
                .filter(d => d.kind === 'audioinput')
                .map(d => ({ deviceId: d.deviceId, label: d.label || `Microfone ${d.deviceId.slice(0,5)}` }));
            
            setAudioDevices(audioInputs);
            if (audioInputs.length > 0 && !selectedDeviceId) setSelectedDeviceId(audioInputs[0].deviceId);
        } catch (e) { console.error(e); }
    };
    getDevices();

    // Init Voices
    const loadVoices = () => {
        const voices = window.speechSynthesis.getVoices();
        setAvailableVoices(voices);
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
        stopPreFlightTest();
        cleanupStudioAudio();
        stopHighPrecisionLoop();
        if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, []);

  // --- TTS Watchdog (Chrome Fix) ---
  useEffect(() => {
      const interval = setInterval(() => {
          if (window.speechSynthesis.speaking) {
              window.speechSynthesis.pause();
              window.speechSynthesis.resume();
          }
      }, 5000); // Keep alive every 5s
      return () => clearInterval(interval);
  }, []);

  // --- Keyboard Shortcuts ---
  
  useEffect(() => {
      if (view !== 'studio') return;
      const handleKeyDown = (e: KeyboardEvent) => {
          if (!refAudioElementRef.current) return;
          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

          const JUMP_SECONDS = 1;
          if (e.key === 'ArrowLeft') {
              e.preventDefault();
              seekTo(Math.max(0, refAudioElementRef.current.currentTime - JUMP_SECONDS));
          } 
          else if (e.key === 'ArrowRight') {
              e.preventDefault();
              seekTo(Math.min(refAudioDuration || 99999, refAudioElementRef.current.currentTime + JUMP_SECONDS));
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, refAudioDuration]);

  // --- View Switching ---

  useEffect(() => {
      if (view === 'studio') {
          if (!selectedDeviceId && audioDevices.length > 0) setSelectedDeviceId(audioDevices[0].deviceId);
          
          processedEntryIds.current = new Set();
          setCurrentMovieTime(0);
          currentMovieTimeRef.current = 0;
          setIsSyncActive(false);
          setSyncConfidence(0);
          setIsLocked(false);
          liveBufferRef.current = [];
          potentialSyncRef.current = null;
          syncLockUntilRef.current = 0;
          isGlobalScanNeeded.current = true; // Reset to global scan on entry
          setLastSpokenText(''); // Reset speech memory
          
          initStudioAudio();
          initReferenceAudio();
          unlockTTS(); // Pre-warm the TTS engine
      } else {
          stopSync();
          cleanupStudioAudio();
          stopHighPrecisionLoop();
          // We do not auto-start preflight to avoid auth issues, wait for user click
          stopPreFlightTest();
          window.speechSynthesis.cancel();
      }
  }, [view]);

  // --- Audio Logic: Pre-flight ---
  
  const startPreFlightTest = async () => {
      stopPreFlightTest();
      if (view !== 'library') return;
      
      setIsPreFlightTesting(true);
      try {
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          preFlightContextRef.current = ctx;

          // Force Resume for browsers that start suspended
          if (ctx.state === 'suspended') {
              await ctx.resume();
          }

          const stream = await navigator.mediaDevices.getUserMedia({ 
              audio: { 
                  deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined, 
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                  channelCount: 1
              } 
          });
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256; 

          // Add Boost Gain for better visibility of low volume
          const gain = ctx.createGain();
          gain.gain.value = 5.0; 

          source.connect(gain);
          gain.connect(analyser);
          
          setPreFlightAnalyser(analyser);
      } catch (e) { 
          console.error(e); 
          setIsPreFlightTesting(false);
      }
  };

  const stopPreFlightTest = () => {
      if (preFlightContextRef.current) {
          preFlightContextRef.current.close();
          preFlightContextRef.current = null;
      }
      setPreFlightAnalyser(null);
      setIsPreFlightTesting(false);
  };

  // --- Matrix Processing (The Math Model) ---

  const processReferenceFile = async () => {
      if (!selectedMovie?.referenceAudioFile) {
          appendLog("Sem ficheiro de áudio matriz!", 'error');
          return false;
      }
      
      setIsProcessingMatrix(true);
      appendLog("A construir modelo matemático...", 'info');

      try {
          const arrayBuffer = await selectedMovie.referenceAudioFile.arrayBuffer();
          const tempCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
          
          audioMatcher.generateMasterFingerprint(audioBuffer);
          
          appendLog("Modelo Construído com Sucesso.", 'success');
          setIsProcessingMatrix(false);
          tempCtx.close();
          return true;
      } catch (e) {
          console.error(e);
          appendLog("Erro ao processar matriz: " + (e as Error).message, 'error');
          setIsProcessingMatrix(false);
          return false;
      }
  };

  // --- Audio Logic: Studio ---

  const initReferenceAudio = () => {
      if (!selectedMovie?.referenceAudioFile) return;
      const fileUrl = URL.createObjectURL(selectedMovie.referenceAudioFile);
      const audio = new Audio(fileUrl);
      audio.crossOrigin = "anonymous";
      audio.loop = false;
      
      audio.onloadedmetadata = () => setRefAudioDuration(audio.duration);
      audio.onplay = () => { setIsPlayingRef(true); startHighPrecisionLoop(); };
      audio.onpause = () => setIsPlayingRef(false);
      
      startHighPrecisionLoop();
      refAudioElementRef.current = audio;
  };

  const startHighPrecisionLoop = () => {
      stopHighPrecisionLoop();
      const loop = () => {
          highPrecisionLoopRef.current = requestAnimationFrame(loop);
          if (refAudioElementRef.current) {
              const t = refAudioElementRef.current.currentTime;
              setCurrentMovieTime(t);
              currentMovieTimeRef.current = t; 
              checkTTS(t);
          }
      };
      loop();
  };

  const stopHighPrecisionLoop = () => {
      if (highPrecisionLoopRef.current) cancelAnimationFrame(highPrecisionLoopRef.current);
  };

  const initStudioAudio = async () => {
      cleanupStudioAudio();
      try {
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          studioContextRef.current = ctx;
          setAudioContextState(ctx.state);

          const stream = await navigator.mediaDevices.getUserMedia({ 
              audio: {
                  channelCount: 1, 
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                  deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined
              }
          });
          
          setStudioStream(stream);
          if (ctx.state === 'suspended') await ctx.resume();

          const micSource = ctx.createMediaStreamSource(stream);
          studioSourceRef.current = micSource;
          const booster = ctx.createGain();
          booster.gain.value = 5.0; 
          studioGainRef.current = booster;
          const micAnalyser = ctx.createAnalyser();
          micAnalyser.fftSize = 256;
          setStudioAnalyser(micAnalyser);
          const processor = ctx.createScriptProcessor(4096, 1, 1);
          
          processor.onaudioprocess = (e) => {
              const input = e.inputBuffer.getChannelData(0);
              const chunk = new Float32Array(input);
              liveBufferRef.current.push(chunk);
              if (liveBufferRef.current.length > 90) { // Keep ~8 sec
                  liveBufferRef.current.shift();
              }
              const output = e.outputBuffer.getChannelData(0);
              for (let i = 0; i < output.length; i++) output[i] = 0;
          };

          micSource.connect(booster);
          booster.connect(micAnalyser);
          booster.connect(processor);
          processor.connect(ctx.destination);
          studioProcessorRef.current = processor;

          if (refAudioElementRef.current) {
              try {
                  const refSource = ctx.createMediaElementSource(refAudioElementRef.current);
                  refSourceNodeRef.current = refSource;
                  const refAnalyserNode = ctx.createAnalyser();
                  refAnalyserNode.fftSize = 256;
                  const muteGain = ctx.createGain();
                  muteGain.gain.value = 0; 
                  
                  refSource.connect(refAnalyserNode);
                  refAnalyserNode.connect(muteGain);
                  muteGain.connect(ctx.destination);
                  setRefAnalyser(refAnalyserNode);
              } catch (e) { console.warn(e); }
          }

          const dataArray = new Uint8Array(micAnalyser.frequencyBinCount);
          const monitorLoop = () => {
              if (!studioContextRef.current) return;
              micAnalyser.getByteFrequencyData(dataArray);
              let sum = 0;
              for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
              setStudioVolume(Math.min(100, Math.round((sum / dataArray.length / 50) * 100)));
              requestAnimationFrame(monitorLoop);
          };
          monitorLoop();

      } catch (e) {
          appendLog("Erro Audio Studio: " + (e as Error).message, 'error');
      }
  };

  const cleanupStudioAudio = () => {
      if (studioProcessorRef.current) { studioProcessorRef.current.disconnect(); studioProcessorRef.current = null; }
      if (studioSourceRef.current) { studioSourceRef.current.disconnect(); studioSourceRef.current = null; }
      if (studioGainRef.current) { studioGainRef.current.disconnect(); studioGainRef.current = null; }
      if (studioStream) { studioStream.getTracks().forEach(t => t.stop()); setStudioStream(null); }
      if (refSourceNodeRef.current) { refSourceNodeRef.current.disconnect(); refSourceNodeRef.current = null; }
      if (studioContextRef.current) { studioContextRef.current.close(); studioContextRef.current = null; }
      setStudioAnalyser(null);
      setRefAnalyser(null);
  };

  const forceResumeAudio = async () => {
      if (studioContextRef.current?.state === 'suspended') {
          await studioContextRef.current.resume();
          setAudioContextState(studioContextRef.current.state);
      }
  };

  const toggleMic = () => {
      if (studioStream) {
          const track = studioStream.getAudioTracks()[0];
          if (track) { track.enabled = !track.enabled; setIsMicMuted(!track.enabled); }
      }
  };

  // --- TTS Logic ---

  const unlockTTS = () => {
      // Create a dummy utterance to unlock speech synthesis on iOS/Safari/Chrome
      if (window.speechSynthesis) {
          window.speechSynthesis.resume(); // Ensure not paused
          const utterance = new SpeechSynthesisUtterance("Ativado");
          utterance.volume = 0; // Silent unlock
          window.speechSynthesis.speak(utterance);
      }
  };

  const manualTestVoice = () => {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      const utterance = new SpeechSynthesisUtterance("Isto é um teste de voz.");
      utterance.lang = 'pt-PT';
      utterance.rate = 1.25;
      const voices = window.speechSynthesis.getVoices();
      const ptVoice = voices.find(v => v.lang === 'pt-PT') || voices.find(v => v.lang.includes('pt'));
      if (ptVoice) utterance.voice = ptVoice;
      window.speechSynthesis.speak(utterance);
  };

  const speak = useCallback((text: string) => {
    if (!window.speechSynthesis) {
        appendLog("TTS não suportado no browser", 'error');
        return;
    }
    
    // Safety check: if currently speaking exactly the same text, don't restart
    // But if text is different (or last spoke finished), allow it
    if (window.speechSynthesis.speaking && text === lastSpokenText) return;
    
    // Ensure engine is running
    window.speechSynthesis.resume();
    
    // Important: Cancel any pending/current speech to prioritize the new sync point
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'pt-PT'; 
    utterance.rate = 1.25; 
    utterance.volume = 1.0;
    
    // Use stored voices state or get fresh
    let voices = availableVoices;
    if (voices.length === 0) voices = window.speechSynthesis.getVoices();

    const ptVoice = voices.find(v => v.lang === 'pt-PT') || voices.find(v => v.lang.includes('pt'));
    if (ptVoice) utterance.voice = ptVoice;
    else appendLog("Voz PT não encontrada, usando padrão", 'info');
    
    utterance.onstart = () => {
        setIsSpeaking(true);
        appendLog(`Lendo: "${text.substring(0, 30)}..."`, 'info');
    };
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = (e) => {
        setIsSpeaking(false);
        console.error("TTS Error", e);
    };
    
    setLastSpokenText(text);
    window.speechSynthesis.speak(utterance);
  }, [lastSpokenText, availableVoices]);

  const checkTTS = (time: number) => {
      if (!selectedMovie) return;
      
      const entryToPlay = selectedMovie.srtEntries.find(entry => {
        // Broadened check: is the current time ANYWHERE inside the entry window?
        const isWithinWindow = time >= entry.startTime && time < entry.endTime;
        const isNotPlayed = !processedEntryIds.current.has(entry.id);
        return isWithinWindow && isNotPlayed;
      });

      if (entryToPlay) {
        processedEntryIds.current.add(entryToPlay.id);
        speak(entryToPlay.text);
      }
  };

  // --- SCROLL LOGIC FIXED ---
  useEffect(() => {
    if (activeSrtRef.current && scriptContainerRef.current) {
        const container = scriptContainerRef.current;
        const activeEl = activeSrtRef.current;
        
        // Calculate relative position within the scroll container
        // offsetTop of element is relative to offsetParent. 
        // If container is relative/absolute, activeEl.offsetTop is distance from top of container.
        
        const containerHeight = container.clientHeight;
        const elementTop = activeEl.offsetTop;
        const elementHeight = activeEl.clientHeight;
        
        // Target scroll position: Center the element
        const targetScrollTop = elementTop - (containerHeight / 2) + (elementHeight / 2);
        
        container.scrollTo({
            top: targetScrollTop,
            behavior: 'smooth'
        });
    }
  }, [currentMovieTime]);

  const seekTo = (time: number) => {
      if (refAudioElementRef.current) {
          const safeTime = Math.max(0, Math.min(refAudioDuration || 9999, time));
          const diff = Math.abs(refAudioElementRef.current.currentTime - safeTime);
          if (diff > 0.5) { 
              refAudioElementRef.current.currentTime = safeTime;
              if (refAudioElementRef.current.paused) refAudioElementRef.current.play();
          }
      }
      
      setCurrentMovieTime(time);
      currentMovieTimeRef.current = time;
      
      // CRITICAL FIX: Reset processed IDs for future entries when seeking
      // We only keep IDs of entries that have ended before the new time
      // This allows re-playing entries if we seek back, and ensures current entry plays if we seek into it
      const newProcessed = new Set<string>();
      selectedMovie?.srtEntries.forEach(entry => {
          if (entry.endTime < time) {
              newProcessed.add(entry.id);
          }
      });
      processedEntryIds.current = newProcessed;
      // Reset Last Spoken text so we can repeat a line if we seeked back to it
      setLastSpokenText('');

      // Immediately check TTS for the new time
      checkTTS(time);

      // Reset lock to verify new position
      setIsLocked(false);
      syncLockUntilRef.current = Date.now() + 5000; 
  };
  
  const forceResync = () => {
      setIsLocked(false);
      syncLockUntilRef.current = 0;
      potentialSyncRef.current = null;
      isGlobalScanNeeded.current = true; // FORCE FULL SCAN
      // IMPORTANT: Clear buffer to avoid matching old audio data
      liveBufferRef.current = [];
      setLastSyncUpdate("A analisar filme completo...");
      setSyncConfidence(0);
      appendLog("Scan Global Solicitado", 'info');
  };

  // --- MATHEMATICAL SYNC ENGINE ---

  const startSync = async () => {
      if (!audioMatcher['masterEnvelope']) {
           const success = await processReferenceFile();
           if (!success) return;
      }

      setIsSyncActive(true);
      setIsLocked(false);
      isGlobalScanNeeded.current = true; // Always start with global
      // Clear buffer on start to avoid noise at beginning matching wrong part
      liveBufferRef.current = [];
      
      appendLog("A iniciar motor de correlação...", 'info');
      unlockTTS(); // Ensure TTS is ready
      
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
      
      syncIntervalRef.current = window.setInterval(() => {
          runSyncCheck();
      }, 2000); 
  };

  const stopSync = () => {
      setIsSyncActive(false);
      setSyncConfidence(0);
      potentialSyncRef.current = null;
      syncLockUntilRef.current = 0;
      setIsLocked(false);
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
      appendLog("Sincronização parada", 'info');
  };

  const runSyncCheck = () => {
      const now = Date.now();
      
      if (syncLockUntilRef.current === Infinity) {
          setIsLocked(true);
          setLastSyncUpdate("🔒 MODO CRUZEIRO");
          setSyncConfidence(100); 
          return;
      } else {
          setIsLocked(false);
      }

      if (!studioContextRef.current || liveBufferRef.current.length < 30) {
          if (isGlobalScanNeeded.current) {
              setLastSyncUpdate("A recolher amostra...");
          }
          return;
      }

      if (now < syncLockUntilRef.current) {
           const remaining = Math.ceil((syncLockUntilRef.current - now) / 1000);
           setLastSyncUpdate(`Estabilizando (${remaining}s)`);
           return;
      }

      // 1. Merge buffers
      const totalLen = liveBufferRef.current.reduce((acc, b) => acc + b.length, 0);
      const combined = new Float32Array(totalLen);
      let offset = 0;
      for (const buf of liveBufferRef.current) {
          combined.set(buf, offset);
          offset += buf.length;
      }

      // 2. Generate Live Fingerprint
      const liveFingerprint = audioMatcher.createLiveFingerprint(combined, studioContextRef.current.sampleRate);

      // 3. Search for Match
      // FORCE GLOBAL SCAN UNTIL LOCKED to prevent local traps
      const isGlobal = isGlobalScanNeeded.current;
      const searchHint = isGlobal ? -1 : currentMovieTimeRef.current;
      const scanWindow = isGlobal ? -1 : 120; // 2 min window if local
      
      if (isGlobal) setLastSyncUpdate("🔎 SCAN GLOBAL...");

      const result = audioMatcher.findMatch(liveFingerprint, searchHint, scanWindow);
      
      setSyncConfidence(Math.round(result.confidence));
      const MIN_CONFIDENCE = isGlobal ? 30 : 40; // Lower threshold for initial discovery

      if (result.confidence > MIN_CONFIDENCE) { 
          // Latency Compensation
          const LATENCY_COMPENSATION = 0.5;
          const adjustedTime = Math.max(0, result.currentTime - LATENCY_COMPENSATION);

          const diff = adjustedTime - currentMovieTimeRef.current;
          const absDiff = Math.abs(diff);

          // TRIPLE CHECK LOGIC -> NOW DOUBLE CHECK
          // If we found a candidate (Global or Drift > 3s)
          if (absDiff > 3.0 || isGlobal) { 
               if (potentialSyncRef.current) {
                   const expectedTime = potentialSyncRef.current.time + ((now - potentialSyncRef.current.timestamp) / 1000);
                   const driftFromExpected = Math.abs(adjustedTime - expectedTime);

                   if (driftFromExpected < 2.0) {
                       const newCount = potentialSyncRef.current.count + 1;
                       potentialSyncRef.current = { 
                           time: adjustedTime, 
                           timestamp: now,
                           count: newCount
                       };
                       setLastSyncUpdate(`Verificação ${newCount}/2`);
                       
                       if (newCount >= 2) {
                           seekTo(adjustedTime);
                           setLastSyncUpdate(`Bloqueado em ${formatTime(adjustedTime)}`);
                           potentialSyncRef.current = null;
                           isGlobalScanNeeded.current = false; // Scan complete AND verified
                           
                           // ENGAGE ETERNAL CRUISE CONTROL
                           syncLockUntilRef.current = Infinity;
                           appendLog(`Sincronização confirmada (${formatTime(adjustedTime)}). Cruzeiro Ativo.`, 'success');
                           return;
                       }
                       return;
                   } else {
                       // Drastic change during verification? Reset.
                       // Keep Global Scan needed because we failed verification
                       potentialSyncRef.current = { time: adjustedTime, timestamp: now, count: 1 };
                       setLastSyncUpdate("Verificação 1/2 (Reset)");
                   }
               } else {
                   // First hit
                   potentialSyncRef.current = { time: adjustedTime, timestamp: now, count: 1 };
                   setLastSyncUpdate("Verificação 1/2");
                   // DO NOT disable Global Scan here. Must prove 2 times.
               }
          } else {
              // Stable.
              potentialSyncRef.current = null;
              setLastSyncUpdate("Monitorizando...");
          }
          
          // Ensure playback if we are close
          if (refAudioElementRef.current?.paused && !isGlobal) {
              refAudioElementRef.current.play();
          }
      } else {
          setLastSyncUpdate(isGlobal ? "A pesquisar filme..." : "Sinal fraco...");
          // If verification fails or confidence drops, reset potential
          if (potentialSyncRef.current) {
              potentialSyncRef.current = null;
              setLastSyncUpdate("Verificação falhou. Reiniciando...");
          }
      }
  };


  const appendLog = (msg: string, type: 'info' | 'error' | 'success' = 'info') => {
      const color = type === 'error' ? '🔴 ' : type === 'success' ? '🟢 ' : 'ℹ️ ';
      setAiDebugLog(prev => [`${color}${msg}`, ...prev].slice(0, 10));
  };

  // --- Helpers ---

  const handleAddMovie = () => {
    if (!newMovieTitle || tempSrt.length === 0) return;
    const newMovie: Movie = {
      id: crypto.randomUUID(),
      title: newMovieTitle,
      srtEntries: tempSrt,
      referenceAudioName: tempAudioName || 'Sem áudio',
      referenceAudioFile: tempAudioFile
    };
    setMovies([...movies, newMovie]);
    setNewMovieTitle(''); setTempSrt([]); setTempAudioName(''); setTempAudioFile(null);
  };

  const handleSrtUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => setTempSrt(parseSRT(ev.target?.result as string));
      reader.readAsText(file);
    }
  };

  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) { setTempAudioName(file.name); setTempAudioFile(file); }
  }

  // --- Render ---

  if (view === 'library') {
    return (
      <div className="space-y-8 animate-in fade-in">
        {/* Config and Create sections same as before, simplified for brevity in this replace block */}
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 shadow-lg">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <Settings size={20} className="text-blue-400"/> Configuração de Entrada
            </h2>
            <div className="grid md:grid-cols-2 gap-6 items-center">
                <div>
                    <label className="block text-sm text-slate-400 mb-2">Microfone</label>
                    <select className="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white outline-none" value={selectedDeviceId} onChange={(e) => setSelectedDeviceId(e.target.value)}>
                        {audioDevices.map(d => (<option key={d.deviceId} value={d.deviceId}>{d.label}</option>))}
                    </select>
                </div>
                <div className="bg-slate-950 rounded-lg overflow-hidden border border-slate-800 h-32 relative">
                    <AudioVisualizer 
                        isActive={isPreFlightTesting} 
                        isSpeaking={true} 
                        analyser={preFlightAnalyser} 
                        label="Teste de Microfone"
                        colorTheme="blue"
                    />
                    {!isPreFlightTesting && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm z-20">
                            <button 
                                onClick={startPreFlightTest}
                                className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-6 rounded-full shadow-lg transition-transform hover:scale-105 flex items-center gap-2"
                            >
                                <Mic size={16} /> Testar Microfone
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>

        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2"><Plus className="text-blue-400" size={20}/> Adicionar Filme</h2>
            <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                    <input type="text" className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white" placeholder="Título do Filme" value={newMovieTitle} onChange={(e) => setNewMovieTitle(e.target.value)} />
                    <div className="flex gap-4">
                        <label className="flex-1 flex flex-col items-center justify-center h-24 border-2 border-dashed border-slate-700 rounded-lg cursor-pointer hover:bg-slate-800">
                            <FileText className="h-6 w-6 text-slate-500 mb-1" />
                            <span className="text-xs text-slate-400">{tempSrt.length > 0 ? `${tempSrt.length} linhas` : 'Upload SRT'}</span>
                            <input type="file" accept=".srt" className="hidden" onChange={handleSrtUpload} />
                        </label>
                        <label className="flex-1 flex flex-col items-center justify-center h-24 border-2 border-dashed border-slate-700 rounded-lg cursor-pointer hover:bg-slate-800">
                            <FileAudio className="h-6 w-6 text-slate-500 mb-1" />
                            <span className="text-xs text-slate-400 truncate max-w-[100px]">{tempAudioName || 'Upload Áudio'}</span>
                            <input type="file" accept="audio/*" className="hidden" onChange={handleAudioUpload} />
                        </label>
                    </div>
                </div>
                <div className="flex items-end">
                    <button onClick={handleAddMovie} disabled={!newMovieTitle || tempSrt.length === 0} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3 px-6 rounded-lg transition-all">Criar Filme</button>
                </div>
            </div>
        </div>

        <div className="grid gap-4">
            {movies.map(movie => (
                <div key={movie.id} className="flex items-center justify-between p-4 bg-slate-800 rounded-lg border border-slate-700">
                    <div className="flex items-center gap-4">
                        <div className="bg-blue-900/30 p-3 rounded-full text-blue-400"><Film size={24} /></div>
                        <div><h4 className="font-bold text-white text-lg">{movie.title}</h4><div className="flex gap-3 text-xs text-slate-400"><span>{movie.srtEntries.length} linhas</span></div></div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={() => { setSelectedMovie(movie); setView('studio'); }} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg font-medium">Entrar no Estúdio</button>
                    </div>
                </div>
            ))}
        </div>
      </div>
    );
  }

  // Studio View
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      
      {/* Top Control Bar */}
      <div className="flex items-center justify-between bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg">
        <div className="flex items-center gap-4">
           <button onClick={() => setView('library')} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors">
               <ArrowLeft size={20} />
           </button>
           <div>
               <h2 className="text-xl font-bold text-white leading-none">{selectedMovie?.title}</h2>
               <div className="text-xs text-slate-400 flex items-center gap-2 mt-1">
                   <span className="flex items-center gap-1"><Mic size={12}/> {audioDevices.find(d => d.deviceId === selectedDeviceId)?.label || 'Mic Padrão'}</span>
                   {audioContextState !== 'running' && <span className="text-yellow-500 flex items-center gap-1"><Activity size={12}/> Audio Suspenso</span>}
               </div>
           </div>
        </div>
        
        <div className="flex items-center gap-3">
             {audioContextState !== 'running' && (
                 <button onClick={forceResumeAudio} className="bg-yellow-600 hover:bg-yellow-500 text-white text-xs px-3 py-2 rounded-lg font-bold flex items-center gap-2 animate-pulse">
                     <Volume2 size={16}/> Ativar Áudio
                 </button>
             )}
            
             {!isSyncActive ? (
                 <button 
                    onClick={startSync} 
                    disabled={isProcessingMatrix}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-6 py-3 rounded-lg font-bold flex items-center gap-2 shadow-lg shadow-blue-900/20 transition-all hover:scale-105"
                 >
                    {isProcessingMatrix ? <Loader2 className="animate-spin" /> : <BrainCircuit size={20} />}
                    {isProcessingMatrix ? "A Processar Matriz..." : "Iniciar Sincronização"}
                 </button>
             ) : (
                 <button onClick={stopSync} className="bg-red-500/10 hover:bg-red-500/20 border border-red-500/50 text-red-400 px-6 py-3 rounded-lg font-bold flex items-center gap-2">
                    <StopCircle size={20} /> Parar
                 </button>
             )}
        </div>
      </div>

      {/* Main Studio Area */}
      <div className="grid lg:grid-cols-3 gap-6">
          
          {/* Left Column: Script */}
          <div ref={scriptContainerRef} className="lg:col-span-1 bg-slate-900 border border-slate-800 rounded-xl flex flex-col h-[500px] shadow-inner relative overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
              <div className="sticky top-0 z-20 p-4 border-b border-slate-800 bg-slate-950/95 backdrop-blur rounded-t-xl flex justify-between items-center shadow-md">
                  <span className="font-bold text-slate-400 text-sm tracking-wider uppercase">Guião Audiodescrição</span>
                  <span className="text-xs bg-slate-800 px-2 py-1 rounded text-slate-500">{selectedMovie?.srtEntries.length} linhas</span>
              </div>
              <div className="p-2 space-y-2">
                  {selectedMovie?.srtEntries.map(entry => {
                      const isActive = processedEntryIds.current.has(entry.id) || (currentMovieTime >= entry.startTime && currentMovieTime < entry.endTime);
                      return (
                          <div 
                            key={entry.id} 
                            ref={isActive ? activeSrtRef : null}
                            className={`p-3 rounded-lg text-sm transition-all duration-300 border ${isActive ? 'bg-blue-900/20 border-blue-500/50 scale-[1.02] shadow-lg' : 'bg-slate-800/50 border-transparent text-slate-400 hover:bg-slate-800'}`}
                          >
                              <div className="flex justify-between mb-1 opacity-70 text-xs font-mono">
                                  <span>{formatTime(entry.startTime)}</span>
                                  <span>#{entry.id}</span>
                              </div>
                              <p className={`leading-relaxed ${isActive ? 'text-white font-medium' : ''}`}>{entry.text}</p>
                          </div>
                      );
                  })}
              </div>
          </div>

          {/* Center Column: Visualizer & Status */}
          <div className="lg:col-span-2 space-y-6">
              
              {/* Visualizers Stack */}
              <div className="relative bg-black rounded-2xl overflow-hidden border border-slate-700 shadow-2xl">
                  {/* Overlay Info */}
                  <div className="absolute top-4 right-4 z-20 flex flex-col items-end gap-2 pointer-events-none">
                      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md transition-colors ${isLocked ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : isSyncActive ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-slate-800/80 text-slate-400 border border-slate-700'}`}>
                          {isLocked ? <Lock size={14} /> : <Activity size={14} className={isSyncActive ? "animate-pulse" : ""} />}
                          {isLocked ? "CRUZEIRO ETERNO" : isSyncActive ? "A SINCRONIZAR" : "AGUARDANDO"}
                      </div>
                      
                      {isSyncActive && !isLocked && (
                        <div className="bg-black/60 backdrop-blur px-3 py-1 rounded text-[10px] text-slate-400 border border-slate-800">
                             Confiança: <span className={`${syncConfidence > 40 ? 'text-green-400' : 'text-yellow-400'}`}>{syncConfidence}%</span>
                        </div>
                      )}

                      {/* Speaking Indicator */}
                      {isSpeaking && (
                          <div className="bg-purple-600/20 text-purple-300 border border-purple-500/50 px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md flex items-center gap-2 animate-pulse">
                              <Megaphone size={14} /> LENDO AGORA...
                          </div>
                      )}
                      
                      {/* Manual Resync Button - only visible when locked */}
                      {isLocked && (
                          <button onClick={forceResync} className="pointer-events-auto bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-2 shadow-lg animate-in fade-in slide-in-from-right-2">
                              <RefreshCw size={12} className="animate-spin-slow" /> Forçar Ressincronização
                          </button>
                      )}
                  </div>
                  
                  {/* Mic Visualizer */}
                  <div className="relative border-b border-slate-800/50">
                     <AudioVisualizer 
                        isActive={true} 
                        isSpeaking={isSpeaking}
                        isMicMuted={isMicMuted}
                        analyser={studioAnalyser}
                        label="Entrada (Microfone)"
                        colorTheme="blue"
                     />
                     {/* Floating Action Button for Mic */}
                     <button onClick={toggleMic} className="absolute bottom-2 right-2 z-30 p-2 rounded-full bg-slate-800/80 text-slate-400 hover:text-white hover:bg-blue-600 transition-all">
                        {isMicMuted ? <MicOff size={16}/> : <Mic size={16}/>}
                     </button>
                  </div>

                  {/* Reference Visualizer */}
                  <div className="relative">
                      <AudioVisualizer 
                        isActive={true} 
                        isSpeaking={false}
                        analyser={refAnalyser}
                        label="Matriz (Referência)"
                        colorTheme="purple"
                     />
                  </div>

                  {/* Current Time Big Display */}
                  <div className="absolute bottom-4 left-4 z-20 font-mono">
                      <div className="text-4xl font-bold text-white tracking-tighter drop-shadow-lg flex items-baseline gap-2">
                          {formatTime(currentMovieTime)}
                          <span className="text-sm font-normal text-slate-400 tracking-normal">filme</span>
                      </div>
                      <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
                          {lastSyncUpdate && <><CheckCircle size={10} className="text-green-500"/> {lastSyncUpdate}</>}
                      </div>
                  </div>
              </div>

              {/* Manual Controls */}
              <div className="bg-slate-800 p-5 rounded-xl border border-slate-700">
                  <div className="flex justify-between items-center mb-4">
                      <label className="text-sm font-bold text-slate-300 flex items-center gap-2"><Settings size={16}/> Ajuste Manual</label>
                      <div className="flex gap-2">
                           <button onClick={manualTestVoice} className="p-2 bg-purple-900/40 hover:bg-purple-900/60 border border-purple-500/20 text-purple-300 rounded text-xs font-bold flex items-center gap-1">
                               <Megaphone size={12} /> Testar Voz
                           </button>
                           <button onClick={() => seekTo(currentMovieTime - 5)} className="p-2 bg-slate-700 hover:bg-slate-600 rounded text-slate-300 text-xs font-mono">-5s</button>
                           <button onClick={() => seekTo(currentMovieTime + 5)} className="p-2 bg-slate-700 hover:bg-slate-600 rounded text-slate-300 text-xs font-mono">+5s</button>
                      </div>
                  </div>
                  <input 
                    type="range" 
                    min="0" 
                    max={refAudioDuration || 100} 
                    value={currentMovieTime} 
                    onChange={(e) => seekTo(parseFloat(e.target.value))}
                    className="w-full h-2 bg-slate-900 rounded-lg appearance-none cursor-pointer accent-blue-500 hover:accent-blue-400"
                  />
                  <div className="flex justify-between mt-2 text-xs text-slate-500 font-mono">
                      <span>00:00:00</span>
                      <span className="flex items-center gap-1"><Keyboard size={12}/> Use as Setas E/D para ajuste fino (1s)</span>
                      <span>{formatTime(refAudioDuration)}</span>
                  </div>
              </div>

              {/* Debug Log */}
              <div className="bg-black/40 border border-slate-800 rounded-lg p-3 h-32 overflow-y-auto font-mono text-xs space-y-1">
                  {aiDebugLog.length === 0 && <span className="text-slate-600 italic">Logs do sistema aparecerão aqui...</span>}
                  {aiDebugLog.map((log, i) => (
                      <div key={i} className="text-slate-400 border-b border-slate-800/30 last:border-0 pb-1">{log}</div>
                  ))}
              </div>

          </div>
      </div>

    </div>
  );
};

export default LiveDescriber;