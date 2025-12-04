import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import { Mic, MicOff, Film, Plus, Play, Trash2, StopCircle, Volume2, Loader2, Activity, AlertTriangle, Settings, FileAudio, RefreshCw, ArrowLeft, FileText, CheckCircle } from 'lucide-react';
import { createPcmBlob, downsampleTo16k } from '../utils/audio';
import { parseSRT, formatTime, SrtEntry } from '../utils/srt';
import AudioVisualizer from './AudioVisualizer';

// --- Types ---

interface Movie {
  id: string;
  title: string;
  srtEntries: SrtEntry[];
  referenceAudioName: string; 
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

  // Audio Config State
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [preFlightVolume, setPreFlightVolume] = useState<number>(0);
  
  // Studio Audio State (The Microphone)
  const [studioStream, setStudioStream] = useState<MediaStream | null>(null);
  const [studioAnalyser, setStudioAnalyser] = useState<AnalyserNode | null>(null);
  const [studioVolume, setStudioVolume] = useState<number>(0);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isInputSilent, setIsInputSilent] = useState(false);
  const [audioContextState, setAudioContextState] = useState<string>('inactive');
  const [studioError, setStudioError] = useState<string | null>(null);

  // AI Session State
  const [isAiConnected, setIsAiConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasSynced, setHasSynced] = useState(false); 
  const [isSpeaking, setIsSpeaking] = useState(false); 
  const [currentMovieTime, setCurrentMovieTime] = useState(0);
  const [lastSyncTimestamp, setLastSyncTimestamp] = useState(0); 
  const [lastReportedMovieTime, setLastReportedMovieTime] = useState(0); 
  
  // Refs
  const preFlightContextRef = useRef<AudioContext | null>(null);
  const studioContextRef = useRef<AudioContext | null>(null);
  const studioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const studioProcessorRef = useRef<ScriptProcessorNode | null>(null); // For sending data to AI
  const sessionRef = useRef<any>(null);
  
  const intervalRef = useRef<any>(null);
  const silenceCheckRef = useRef<number>(0);
  const lastReadEntryId = useRef<string | null>(null);

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
            if (audioInputs.length > 0) {
                setSelectedDeviceId(audioInputs[0].deviceId);
            }
        } catch (e) {
            console.error("Error fetching devices", e);
        }
    };
    getDevices();

    return () => {
        stopPreFlightTest();
        cleanupStudioAudio();
    };
  }, []);

  // --- View Switching & Auto-Audio ---

  useEffect(() => {
      if (view === 'studio') {
          // Verify we have a selected device
          if (!selectedDeviceId && audioDevices.length > 0) {
              setSelectedDeviceId(audioDevices[0].deviceId);
          }
          // Start Studio Audio Loop
          initStudioAudio();
      } else {
          // Cleanup Studio Audio
          cleanupStudioAudio();
          // Restart Preflight if back in library
          if (selectedDeviceId) startPreFlightTest(selectedDeviceId);
      }
  }, [view]);

  // --- Audio Logic: Pre-flight (Library) ---
  
  const startPreFlightTest = async (deviceId: string) => {
      stopPreFlightTest();
      if (view !== 'library') return;

      try {
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          preFlightContextRef.current = ctx;
          const stream = await navigator.mediaDevices.getUserMedia({ 
              audio: { deviceId: { exact: deviceId }, echoCancellation: false } 
          });
          
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          
          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          const checkVolume = () => {
              if (!preFlightContextRef.current) return;
              analyser.getByteFrequencyData(dataArray);
              let sum = 0;
              for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
              const average = sum / dataArray.length;
              setPreFlightVolume(Math.min(100, Math.round((average / 128) * 100)));
              requestAnimationFrame(checkVolume);
          };
          checkVolume();
      } catch (e) { console.error(e); }
  };

  const stopPreFlightTest = () => {
      if (preFlightContextRef.current) {
          preFlightContextRef.current.close();
          preFlightContextRef.current = null;
      }
      setPreFlightVolume(0);
  };

  useEffect(() => {
      if (view === 'library' && selectedDeviceId) startPreFlightTest(selectedDeviceId);
  }, [selectedDeviceId]);

  // --- Audio Logic: Studio (Session) ---

  const initStudioAudio = async () => {
      cleanupStudioAudio();
      setStudioError(null);
      
      try {
          // 1. Create Context
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          studioContextRef.current = ctx;
          setAudioContextState(ctx.state);

          // 2. Get Stream (Reuse Library Config)
          const stream = await navigator.mediaDevices.getUserMedia({ 
              audio: { 
                  deviceId: { exact: selectedDeviceId }, 
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false
              } 
          });
          setStudioStream(stream);

          // 3. Create Source & Analyser (Visualizer Branch)
          const source = ctx.createMediaStreamSource(stream);
          studioSourceRef.current = source;

          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          setStudioAnalyser(analyser);

          // 4. Monitoring Loop (Volume & Silence)
          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          
          const monitorLoop = () => {
              if (!studioContextRef.current) return;
              
              // Check State
              if (studioContextRef.current.state !== audioContextState) {
                  setAudioContextState(studioContextRef.current.state);
              }

              analyser.getByteFrequencyData(dataArray);
              
              let sum = 0;
              for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
              const average = sum / dataArray.length;
              const vol = Math.min(100, Math.round((average / 128) * 100));
              setStudioVolume(vol);

              // Silence Detection
              if (vol === 0) {
                  silenceCheckRef.current++;
                  if (silenceCheckRef.current > 100) setIsInputSilent(true); // ~1.5s
              } else {
                  silenceCheckRef.current = 0;
                  setIsInputSilent(false);
              }

              requestAnimationFrame(monitorLoop);
          };
          monitorLoop();

      } catch (e) {
          console.error("Studio Audio Init Failed", e);
          setStudioError("Falha ao iniciar microfone. Verifique permissões.");
      }
  };

  const cleanupStudioAudio = () => {
      if (studioProcessorRef.current) {
          studioProcessorRef.current.disconnect();
          studioProcessorRef.current = null;
      }
      if (studioSourceRef.current) {
          studioSourceRef.current.disconnect();
          studioSourceRef.current = null;
      }
      if (studioStream) {
          studioStream.getTracks().forEach(t => t.stop());
          setStudioStream(null);
      }
      if (studioContextRef.current) {
          studioContextRef.current.close();
          studioContextRef.current = null;
      }
      setStudioAnalyser(null);
      setStudioVolume(0);
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
          if (track) {
              track.enabled = !track.enabled;
              setIsMicMuted(!track.enabled);
          }
      }
  };

  // --- TTS Logic ---

  const speak = useCallback((text: string) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'pt-PT'; 
    utterance.rate = 1.1; 
    const voices = window.speechSynthesis.getVoices();
    const ptVoice = voices.find(v => v.lang === 'pt-PT') || voices.find(v => v.lang.includes('pt'));
    if (ptVoice) utterance.voice = ptVoice;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, []);

  // --- Sync Clock ---

  useEffect(() => {
    if (!isAiConnected || !selectedMovie) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
    }

    intervalRef.current = setInterval(() => {
      if (!hasSynced) return;
      const now = Date.now();
      const elapsedRealTime = (now - lastSyncTimestamp) / 1000;
      const estimatedTime = lastReportedMovieTime + elapsedRealTime;
      setCurrentMovieTime(estimatedTime);

      const entryToPlay = selectedMovie.srtEntries.find(entry => {
        const timeDiff = Math.abs(entry.startTime - estimatedTime);
        return timeDiff < 0.3 && lastReadEntryId.current !== entry.id; 
      });

      if (entryToPlay) {
        lastReadEntryId.current = entryToPlay.id;
        speak(entryToPlay.text);
      }
    }, 100); 

    return () => clearInterval(intervalRef.current);
  }, [isAiConnected, selectedMovie, lastSyncTimestamp, lastReportedMovieTime, speak, hasSynced]);


  // --- Gemini Connection ---

  const startGeminiSession = async () => {
    if (!selectedMovie || !studioContextRef.current || !studioSourceRef.current) return;
    
    setIsConnecting(true);

    try {
      const ai = new GoogleGenAI({ apiKey });
      const scriptContext = selectedMovie.srtEntries
        .map(e => `[${formatTime(e.startTime)}] ${e.text}`)
        .join('\n');

      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        responseModalities: [Modality.AUDIO], 
        systemInstruction: {
            parts: [{ 
                text: `You are CineVoz, a precise Audio Sync Engine.
                Match audio to: "${selectedMovie.title}".
                REFERENCE AUDIO FILE: ${selectedMovie.referenceAudioName}
                
                SCRIPT:
                ${scriptContext}
                
                INSTRUCTIONS:
                1. Listen for dialogue/sound matches.
                2. CALL 'report_playback_time' IMMEDIATELY when you recognize the position.
                3. Update regularly.` 
            }]
        },
        tools: [{
            functionDeclarations: [{
                name: 'report_playback_time',
                description: 'Reports current movie timestamp.',
                parameters: {
                    type: Type.OBJECT,
                    properties: { seconds: { type: Type.NUMBER } },
                    required: ['seconds']
                }
            }]
        }]
      };

      const session = await ai.live.connect({ 
        config,
        callbacks: {
            onopen: () => {
                setIsAiConnected(true);
                setIsConnecting(false);
                attachAiProcessor(session); // Connect Audio -> AI
            },
            onmessage: (msg: LiveServerMessage) => {
                if (msg.toolCall) {
                    msg.toolCall.functionCalls.forEach(fc => {
                        if (fc.name === 'report_playback_time') {
                            const args = fc.args as any;
                            const newTime = typeof args.seconds === 'number' ? args.seconds : parseFloat(args.seconds);
                            setHasSynced(true);
                            setLastReportedMovieTime(newTime);
                            setLastSyncTimestamp(Date.now());
                            setCurrentMovieTime(newTime);
                            session.sendToolResponse({
                                functionResponses: { name: fc.name, id: fc.id, response: { result: "ok" } }
                            });
                        }
                    });
                }
            },
            onclose: () => { disconnectAi(); },
            onerror: () => { disconnectAi(); }
        } 
      });
      sessionRef.current = session;

    } catch (e) {
      alert("Erro ao ligar IA: " + (e as Error).message);
      disconnectAi();
    }
  };

  const attachAiProcessor = (session: any) => {
      const ctx = studioContextRef.current;
      const source = studioSourceRef.current;
      if (!ctx || !source) return;

      // Create processor if it doesn't exist
      // We use ScriptProcessor for raw PCM access
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
          // Prevent feedback
          const output = e.outputBuffer.getChannelData(0);
          output.fill(0);
          
          // Get input
          const input = e.inputBuffer.getChannelData(0);
          
          // Send to AI
          const downsampled = downsampleTo16k(input, ctx.sampleRate);
          session.sendRealtimeInput({ media: createPcmBlob(downsampled) });
      };

      // Connect: Source -> Processor -> Destination
      // Note: We tap off the SAME source that feeds the visualizer
      source.connect(processor);
      processor.connect(ctx.destination);
      
      studioProcessorRef.current = processor;
  };

  const disconnectAi = () => {
      if (sessionRef.current) try { sessionRef.current.close(); } catch(e){}
      if (studioProcessorRef.current) {
          studioProcessorRef.current.disconnect();
          studioProcessorRef.current = null;
      }
      sessionRef.current = null;
      setIsAiConnected(false);
      setIsConnecting(false);
      setHasSynced(false);
      // We DO NOT close the audio context here, user remains in Studio
  };

  // --- Helpers ---

  const handleAddMovie = () => {
    if (!newMovieTitle || tempSrt.length === 0) return;
    const newMovie: Movie = {
      id: crypto.randomUUID(),
      title: newMovieTitle,
      srtEntries: tempSrt,
      referenceAudioName: tempAudioName || 'Sem áudio de referência'
    };
    setMovies([...movies, newMovie]);
    setNewMovieTitle('');
    setTempSrt([]);
    setTempAudioName('');
  };

  const handleSrtUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const parsed = parseSRT(ev.target?.result as string);
        setTempSrt(parsed);
      };
      reader.readAsText(file);
    }
  };

  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) { setTempAudioName(file.name); }
  }

  const deleteMovie = (id: string) => {
    setMovies(movies.filter(m => m.id !== id));
  };

  // --- Render ---

  if (view === 'library') {
    return (
      <div className="space-y-8 animate-in fade-in">
        
        {/* Audio Config */}
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 shadow-lg">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <Settings size={20} className="text-blue-400"/>
                Configuração de Entrada
            </h2>
            <div className="grid md:grid-cols-2 gap-6 items-center">
                <div>
                    <label className="block text-sm text-slate-400 mb-2">Microfone</label>
                    <select 
                        className="w-full bg-slate-800 border border-slate-600 rounded-lg p-3 text-white outline-none focus:border-blue-500"
                        value={selectedDeviceId}
                        onChange={(e) => setSelectedDeviceId(e.target.value)}
                    >
                        {audioDevices.map(d => (
                            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                        ))}
                    </select>
                </div>
                <div className="bg-slate-950 rounded-lg p-4 border border-slate-800">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                        <span>Teste de Som</span>
                        <span>{preFlightVolume > 0 ? `${preFlightVolume}%` : 'Sem sinal'}</span>
                    </div>
                    <div className="h-4 bg-slate-800 rounded-full overflow-hidden">
                        <div 
                            className={`h-full transition-all duration-100 ${preFlightVolume > 5 ? 'bg-green-500' : 'bg-slate-700'}`}
                            style={{ width: `${preFlightVolume}%` }}
                        ></div>
                    </div>
                </div>
            </div>
        </div>

        {/* Create Movie */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                <Plus className="text-blue-400" size={20}/>
                Adicionar Filme à Biblioteca
            </h2>
            <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm text-slate-400 mb-1">Título</label>
                        <input 
                            type="text" 
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="Ex: O Padrinho"
                            value={newMovieTitle}
                            onChange={(e) => setNewMovieTitle(e.target.value)}
                        />
                    </div>
                    <div className="flex gap-4">
                        <label className="flex-1 flex flex-col items-center justify-center h-24 border-2 border-dashed border-slate-700 rounded-lg cursor-pointer hover:bg-slate-800 transition-colors">
                            <FileText className="h-6 w-6 text-slate-500 mb-1" />
                            <span className="text-xs text-slate-400">{tempSrt.length > 0 ? `${tempSrt.length} linhas` : 'SRT (Texto)'}</span>
                            <input type="file" accept=".srt" className="hidden" onChange={handleSrtUpload} />
                        </label>
                        <label className="flex-1 flex flex-col items-center justify-center h-24 border-2 border-dashed border-slate-700 rounded-lg cursor-pointer hover:bg-slate-800 transition-colors">
                            <FileAudio className="h-6 w-6 text-slate-500 mb-1" />
                            <span className="text-xs text-slate-400 truncate max-w-[100px]">{tempAudioName || 'Áudio (Ref)'}</span>
                            <input type="file" accept="audio/*" className="hidden" onChange={handleAudioUpload} />
                        </label>
                    </div>
                </div>
                <div className="flex items-end">
                    <button 
                        onClick={handleAddMovie}
                        disabled={!newMovieTitle || tempSrt.length === 0}
                        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3 px-6 rounded-lg transition-all"
                    >
                        Criar Filme
                    </button>
                </div>
            </div>
        </div>

        {/* Movie List */}
        <div className="grid gap-4">
            {movies.map(movie => (
                <div key={movie.id} className="flex items-center justify-between p-4 bg-slate-800 rounded-lg border border-slate-700">
                    <div className="flex items-center gap-4">
                        <div className="bg-blue-900/30 p-3 rounded-full text-blue-400">
                            <Film size={24} />
                        </div>
                        <div>
                            <h4 className="font-bold text-white text-lg">{movie.title}</h4>
                            <div className="flex gap-3 text-xs text-slate-400">
                                <span>{movie.srtEntries.length} linhas</span>
                                <span className="flex items-center gap-1"><FileAudio size={12}/> {movie.referenceAudioName}</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={() => deleteMovie(movie.id)} className="p-2 text-red-400 hover:bg-red-900/20 rounded-lg"><Trash2 size={20} /></button>
                        <button 
                            onClick={() => { setSelectedMovie(movie); setView('studio'); }}
                            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                        >
                            <Play size={16} /> Entrar no Estúdio
                        </button>
                    </div>
                </div>
            ))}
        </div>
      </div>
    );
  }

  // Studio View
  const selectedDeviceLabel = audioDevices.find(d => d.deviceId === selectedDeviceId)?.label;

  return (
    <div className="space-y-6 animate-in slide-in-from-right" onClick={forceResumeAudio}>
        {/* Top Bar */}
        <div className="flex items-center gap-4 mb-6">
            <button 
                onClick={() => { disconnectAi(); setView('library'); }}
                className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium bg-slate-800 px-3 py-2 rounded-lg"
            >
                <ArrowLeft size={16}/> Biblioteca
            </button>
            <h2 className="text-2xl font-bold text-white truncate flex-1">{selectedMovie?.title}</h2>
            
            {/* Sync Status Badge */}
            {isAiConnected ? (
                hasSynced ? (
                    <span className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30 font-bold text-sm">
                        <CheckCircle size={14}/> Sincronizado
                    </span>
                ) : (
                    <span className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30 font-bold text-sm animate-pulse">
                        <Loader2 size={14} className="animate-spin"/> Ouvindo Filme...
                    </span>
                )
            ) : (
                <span className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-slate-700 text-slate-400 border border-slate-600 font-medium text-sm">
                    <StopCircle size={14}/> IA Desligada
                </span>
            )}
        </div>

        {/* Main Audio Visualizer & Controls */}
        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-1 overflow-hidden shadow-2xl relative group">
            
            {/* Diagnostics Overlay */}
            <div className="absolute top-3 left-3 z-20 flex flex-col gap-1 pointer-events-none">
                <div className="flex items-center gap-2">
                    <Activity size={14} className={studioVolume > 2 ? "text-green-500" : "text-slate-600"} />
                    <span className="text-[10px] text-slate-600 bg-black/40 px-1 rounded backdrop-blur-sm">
                        MIC: {studioVolume}% | {audioContextState.toUpperCase()}
                    </span>
                </div>
                <span className="text-[10px] text-slate-600 bg-black/40 px-1 rounded max-w-[200px] truncate">
                    {selectedDeviceLabel}
                </span>
            </div>

            {/* Error Message */}
            {(studioError || isInputSilent) && !isMicMuted && (
                <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 bg-red-500/90 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 text-sm font-bold backdrop-blur-sm animate-bounce">
                    <AlertTriangle size={18}/>
                    {studioError || "Sem som detetado. Verifique o volume."}
                </div>
            )}

            {/* Resume Button */}
            {audioContextState === 'suspended' && (
                 <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <button 
                        onClick={(e) => { e.stopPropagation(); forceResumeAudio(); }}
                        className="bg-yellow-500 hover:bg-yellow-400 text-black px-6 py-3 rounded-xl font-bold flex items-center gap-2 shadow-xl transform hover:scale-105 transition-all"
                    >
                        <RefreshCw size={20}/> CLIQUE PARA ATIVAR ÁUDIO
                    </button>
                </div>
            )}

            {/* Mute Toggle */}
            <button
                onClick={(e) => { e.stopPropagation(); toggleMic(); }}
                className={`absolute top-3 right-3 z-30 p-2 rounded-full transition-all cursor-pointer ${isMicMuted ? 'bg-red-500 text-white' : 'bg-slate-800/80 text-slate-400 hover:text-white'}`}
            >
                {isMicMuted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            
            {/* Visualizer - Always renders if we have analyser */}
            <AudioVisualizer 
                isActive={true} 
                isSpeaking={isSpeaking}
                isMicMuted={isMicMuted}
                analyser={studioAnalyser}
            />
            
            {/* Control Bar */}
            <div className="p-4 bg-slate-900 border-t border-slate-800 flex items-center justify-between">
                <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-0.5">Tempo do Filme</span>
                    <div className={`text-3xl font-mono font-bold tabular-nums ${hasSynced ? 'text-blue-400' : 'text-slate-600'}`}>
                        {formatTime(currentMovieTime)}
                    </div>
                </div>

                {isAiConnected ? (
                     <button 
                        onClick={(e) => { e.stopPropagation(); disconnectAi(); }} 
                        className="flex items-center gap-2 bg-red-600 hover:bg-red-500 text-white px-8 py-3 rounded-xl font-bold shadow-lg shadow-red-900/20 transition-all hover:translate-y-[-2px]"
                    >
                        <StopCircle size={20} /> Parar Sincronização
                    </button>
                ) : (
                    <button 
                        onClick={(e) => { e.stopPropagation(); startGeminiSession(); }} 
                        disabled={isConnecting}
                        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-8 py-3 rounded-xl font-bold shadow-lg shadow-blue-900/20 transition-all hover:translate-y-[-2px]"
                    >
                        {isConnecting ? <Loader2 className="animate-spin" size={20}/> : <Play size={20} />} 
                        Iniciar Sincronização
                    </button>
                )}
            </div>
        </div>

        {/* Script Viewer */}
        <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden flex flex-col h-[400px] shadow-lg">
            <div className="p-4 border-b border-slate-700 bg-slate-800/50 flex justify-between items-center backdrop-blur">
                <h3 className="font-semibold text-slate-300 flex items-center gap-2">
                    <Volume2 size={18} /> Guião de Audiodescrição
                </h3>
                <span className="text-xs text-slate-500 bg-slate-900 px-2 py-1 rounded">
                    {selectedMovie?.srtEntries.length} linhas
                </span>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-3 scroll-smooth">
                {selectedMovie?.srtEntries.map((entry) => {
                    const isCurrent = currentMovieTime >= entry.startTime && currentMovieTime <= entry.endTime;
                    return (
                        <div 
                            key={entry.id} 
                            id={`srt-${entry.id}`}
                            className={`p-4 rounded-lg border transition-all duration-300 relative ${
                                isCurrent 
                                    ? 'bg-blue-600/20 border-blue-500/50 scale-[1.01] shadow-md z-10' 
                                    : 'bg-slate-700/30 border-slate-700/50 hover:bg-slate-700/50'
                            }`}
                        >
                            <span className={`text-[10px] font-mono block mb-1.5 ${isCurrent ? 'text-blue-300' : 'text-slate-500'}`}>
                                {formatTime(entry.startTime)}
                            </span>
                            <p className={`text-base leading-relaxed ${isCurrent ? 'text-white font-medium' : 'text-slate-400'}`}>
                                {entry.text}
                            </p>
                        </div>
                    );
                })}
            </div>
        </div>
    </div>
  );
};

export default LiveDescriber;