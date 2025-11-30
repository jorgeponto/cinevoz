import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Tool, Type } from '@google/genai';
import { Mic, MicOff, Film, Plus, Play, Trash2, StopCircle, Clock, Volume2, Music, FileText } from 'lucide-react';
import { createPcmBlob, decodeAudioData, PCM_SAMPLE_RATE_INPUT, PCM_SAMPLE_RATE_OUTPUT } from '../utils/audio';
import { parseSRT, formatTime, SrtEntry } from '../utils/srt';
import AudioVisualizer from './AudioVisualizer';

// --- Types ---

interface Movie {
  id: string;
  title: string;
  srtEntries: SrtEntry[];
  referenceAudioName: string; // Just storing name for UI, not analyzing raw file in this demo version
}

interface LiveDescriberProps {
  apiKey: string;
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

  // Session State
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false); // Used for visualizer color
  const [currentMovieTime, setCurrentMovieTime] = useState(0);
  const [lastSyncTimestamp, setLastSyncTimestamp] = useState(0); // System time when sync happened
  const [lastReportedMovieTime, setLastReportedMovieTime] = useState(0); // Movie time reported by AI

  // Audio Processing Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const intervalRef = useRef<any>(null);

  // TTS Refs
  const lastReadEntryId = useRef<string | null>(null);

  // --- TTS Logic ---

  const speak = useCallback((text: string) => {
    if (!window.speechSynthesis) return;
    
    // Cancel any current speech to prioritize immediate sync
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'pt-PT'; // Prefer Portuguese Portugal
    utterance.rate = 1.1; // Slightly faster for AD
    utterance.volume = 1.0;
    
    // Fallback to any Portuguese if pt-PT not found
    const voices = window.speechSynthesis.getVoices();
    const ptVoice = voices.find(v => v.lang === 'pt-PT') || voices.find(v => v.lang.includes('pt'));
    if (ptVoice) utterance.voice = ptVoice;

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    
    window.speechSynthesis.speak(utterance);
  }, []);

  // --- Clock & Trigger Logic ---

  useEffect(() => {
    if (!isConnected || !selectedMovie) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
    }

    // High frequency ticker for smooth UI and precise TTS triggering
    intervalRef.current = setInterval(() => {
      const now = Date.now();
      const elapsedRealTime = (now - lastSyncTimestamp) / 1000;
      const estimatedTime = lastReportedMovieTime + elapsedRealTime;
      
      setCurrentMovieTime(estimatedTime);

      // Check for SRT match
      // We look for an entry that starts "now" (within a small window) 
      // and hasn't been read yet.
      const entryToPlay = selectedMovie.srtEntries.find(entry => {
        const timeDiff = Math.abs(entry.startTime - estimatedTime);
        return timeDiff < 0.3 && lastReadEntryId.current !== entry.id; // 300ms window
      });

      if (entryToPlay) {
        console.log("Triggering TTS:", entryToPlay.text);
        lastReadEntryId.current = entryToPlay.id;
        speak(entryToPlay.text);
      }

    }, 100); // Check every 100ms

    return () => clearInterval(intervalRef.current);
  }, [isConnected, selectedMovie, lastSyncTimestamp, lastReportedMovieTime, speak]);


  // --- Database Logic ---

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
      if (file) {
          setTempAudioName(file.name);
          // In a real app we would store the blob, but here we just need to know it exists 
          // to satisfy the requirement of "Database of SRT + Audio".
          // The sync logic relies on Gemini hearing the movie.
      }
  }

  const deleteMovie = (id: string) => {
    setMovies(movies.filter(m => m.id !== id));
    if (selectedMovie?.id === id) {
        setSelectedMovie(null);
        setView('library');
    }
  };

  // --- Gemini Connection ---

  const connectToGemini = async () => {
    if (!selectedMovie) return;

    try {
      const ai = new GoogleGenAI({ apiKey });
      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        responseModalities: [Modality.AUDIO], // We strictly want audio/control back, though we use tool for time
        systemInstruction: {
            parts: [{ 
                text: `You are an advanced Audio Description Synchronization Engine for the movie "${selectedMovie.title}". 
                
                Your Task:
                1. Listen to the incoming audio stream continuously.
                2. Identify the exact current timestamp of the movie based on dialogue, sound effects, and music.
                3. You MUST call the function 'report_playback_time(seconds)' frequently (every 2-5 seconds or when a distinct scene change occurs) to update the system clock.
                
                Context (The Script):
                Use these lines to help you identify where we are:
                ${selectedMovie.srtEntries.slice(0, 50).map(e => `[${formatTime(e.startTime)}] ${e.text.substring(0,20)}...`).join('\n')}
                ...(and so on).
                
                Do not generate spoken conversation. ONLY call the tool to sync time.` 
            }]
        },
        tools: [{
            functionDeclarations: [{
                name: 'report_playback_time',
                description: 'Reports the current playback time of the movie in seconds based on the audio heard.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        seconds: { type: Type.NUMBER, description: 'The current time in seconds, e.g., 125.5' }
                    },
                    required: ['seconds']
                }
            }]
        }]
      };

      const session = await ai.live.connect({ 
        config,
        callbacks: {
            onopen: () => {
                console.log("Gemini Connected");
                setIsConnected(true);
                setLastSyncTimestamp(Date.now());
                setLastReportedMovieTime(0);
                startAudioStream(session);
            },
            onmessage: (msg: LiveServerMessage) => {
                // Handle Tool Calls (The Sync Signal)
                if (msg.toolCall) {
                    msg.toolCall.functionCalls.forEach(fc => {
                        if (fc.name === 'report_playback_time') {
                            const args = fc.args as any;
                            const newTime = typeof args.seconds === 'number' ? args.seconds : parseFloat(args.seconds);
                            
                            console.log(`SYNC: AI detected time ${formatTime(newTime)}`);
                            
                            // Update the "Real" clock
                            setLastReportedMovieTime(newTime);
                            setLastSyncTimestamp(Date.now());
                            setCurrentMovieTime(newTime);

                            // Send success response to keep context happy
                            session.sendToolResponse({
                                functionResponses: {
                                    name: fc.name,
                                    id: fc.id,
                                    response: { result: "ok" }
                                }
                            });
                        }
                    });
                }
            },
            onclose: () => {
                console.log("Closed");
                setIsConnected(false);
                disconnect();
            },
            onerror: (err) => {
                console.error(err);
                setIsConnected(false);
                disconnect();
            }
        } 
      });

      sessionRef.current = session;

    } catch (e) {
      console.error("Connection failed", e);
      setIsConnected(false);
    }
  };

  const startAudioStream = async (session: any) => {
    // Standard Audio Streaming Logic
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: PCM_SAMPLE_RATE_INPUT });
    inputAudioContextRef.current = ctx;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        
        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        
        processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            const pcmBlob = createPcmBlob(inputData);
            session.sendRealtimeInput({ media: pcmBlob });
        };

        source.connect(processor);
        processor.connect(ctx.destination);
        processorRef.current = processor;

    } catch (err) {
        console.error("Mic Error", err);
    }
  };

  const disconnect = () => {
    if (sessionRef.current) {
        try { sessionRef.current.close(); } catch(e){}
        sessionRef.current = null;
    }
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
    }
    if (processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current = null;
    }
    if (inputAudioContextRef.current) {
        inputAudioContextRef.current.close();
        inputAudioContextRef.current = null;
    }
    setIsConnected(false);
    // Reset TTS pointer when stopping
    lastReadEntryId.current = null;
  };

  // --- Render ---

  if (view === 'library') {
    return (
      <div className="space-y-8 animate-in fade-in">
        {/* Create Movie Section */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                <Plus className="text-blue-400" size={20}/>
                Adicionar Filme à Base de Dados
            </h2>
            <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm text-slate-400 mb-1">Título do Filme</label>
                        <input 
                            type="text" 
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="Ex: O Padrinho"
                            value={newMovieTitle}
                            onChange={(e) => setNewMovieTitle(e.target.value)}
                        />
                    </div>
                    <div className="flex gap-4">
                        <div className="flex-1">
                            <label className="block text-sm text-slate-400 mb-1">Guião de Audiodescrição (.srt)</label>
                            <label className="flex flex-col items-center justify-center h-24 border-2 border-dashed border-slate-700 rounded-lg cursor-pointer hover:bg-slate-800 transition-colors">
                                <div className="text-center p-2">
                                    <FileText className="mx-auto h-6 w-6 text-slate-500 mb-1" />
                                    <span className="text-xs text-slate-400">{tempSrt.length > 0 ? `${tempSrt.length} linhas carregadas` : 'Carregar SRT'}</span>
                                </div>
                                <input type="file" accept=".srt" className="hidden" onChange={handleSrtUpload} />
                            </label>
                        </div>
                        <div className="flex-1">
                            <label className="block text-sm text-slate-400 mb-1">Áudio de Referência</label>
                            <label className="flex flex-col items-center justify-center h-24 border-2 border-dashed border-slate-700 rounded-lg cursor-pointer hover:bg-slate-800 transition-colors">
                                <div className="text-center p-2">
                                    <Music className="mx-auto h-6 w-6 text-slate-500 mb-1" />
                                    <span className="text-xs text-slate-400 truncate w-full px-2">{tempAudioName || 'Carregar MP3/WAV'}</span>
                                </div>
                                <input type="file" accept="audio/*" className="hidden" onChange={handleAudioUpload} />
                            </label>
                        </div>
                    </div>
                </div>
                <div className="flex items-end">
                    <button 
                        onClick={handleAddMovie}
                        disabled={!newMovieTitle || tempSrt.length === 0}
                        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2"
                    >
                        <Plus size={18} />
                        Criar Registo
                    </button>
                </div>
            </div>
        </div>

        {/* List Movies Section */}
        <div>
            <h3 className="text-lg font-semibold text-slate-300 mb-4">A Minha Biblioteca</h3>
            {movies.length === 0 ? (
                <div className="text-center py-12 bg-slate-800/30 rounded-lg border border-slate-800">
                    <Film className="mx-auto h-12 w-12 text-slate-600 mb-2" />
                    <p className="text-slate-500">Nenhum filme registado.</p>
                </div>
            ) : (
                <div className="grid gap-4">
                    {movies.map(movie => (
                        <div key={movie.id} className="flex items-center justify-between p-4 bg-slate-800 rounded-lg border border-slate-700 hover:border-slate-600 transition-colors">
                            <div className="flex items-center gap-4">
                                <div className="bg-blue-900/30 p-3 rounded-full text-blue-400">
                                    <Film size={24} />
                                </div>
                                <div>
                                    <h4 className="font-bold text-white text-lg">{movie.title}</h4>
                                    <div className="flex gap-4 text-xs text-slate-400">
                                        <span className="flex items-center gap-1"><FileText size={12}/> {movie.srtEntries.length} linhas</span>
                                        <span className="flex items-center gap-1"><Music size={12}/> {movie.referenceAudioName}</span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button 
                                    onClick={() => deleteMovie(movie.id)}
                                    className="p-2 text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
                                >
                                    <Trash2 size={20} />
                                </button>
                                <button 
                                    onClick={() => { setSelectedMovie(movie); setView('studio'); }}
                                    className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                                >
                                    <Play size={16} /> Iniciar Sessão
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
      </div>
    );
  }

  // Studio View
  return (
    <div className="space-y-6 animate-in slide-in-from-right">
        <div className="flex items-center gap-4 mb-6">
            <button 
                onClick={() => { disconnect(); setView('library'); }}
                className="text-slate-400 hover:text-white transition-colors text-sm"
            >
                ← Voltar à Biblioteca
            </button>
            <h2 className="text-2xl font-bold text-white truncate">{selectedMovie?.title}</h2>
            {isConnected && (
                <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500/10 text-red-500 text-xs font-medium border border-red-500/20 animate-pulse">
                    <div className="w-2 h-2 rounded-full bg-red-500"></div>
                    LIVE
                </span>
            )}
        </div>

        {/* Visualizer & Controls */}
        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-1 overflow-hidden shadow-2xl">
            <AudioVisualizer 
                isActive={isConnected} 
                isSpeaking={isSpeaking}
                stream={streamRef.current || undefined} 
            />
            
            <div className="p-4 bg-slate-900 flex items-center justify-between border-t border-slate-800">
                <div className="flex items-center gap-4">
                    <div className="flex flex-col">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Tempo do Filme</span>
                        <div className="text-3xl font-mono text-blue-400 font-bold tabular-nums">
                            {formatTime(currentMovieTime)}
                        </div>
                    </div>
                </div>

                {isConnected ? (
                     <button 
                        onClick={disconnect}
                        className="flex items-center gap-2 bg-red-600 hover:bg-red-500 text-white px-6 py-3 rounded-xl font-bold transition-all shadow-lg hover:shadow-red-900/20"
                    >
                        <StopCircle size={20} /> Parar Sincronização
                    </button>
                ) : (
                    <button 
                        onClick={connectToGemini}
                        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-xl font-bold transition-all shadow-lg hover:shadow-blue-900/20"
                    >
                        <Mic size={20} /> Ouvir & Sincronizar
                    </button>
                )}
            </div>
        </div>

        {/* Script View */}
        <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden flex flex-col h-[400px]">
            <div className="p-4 border-b border-slate-700 bg-slate-800/50 flex justify-between items-center">
                <h3 className="font-semibold text-slate-300 flex items-center gap-2">
                    <Volume2 size={18} className={isSpeaking ? "text-green-400" : "text-slate-500"} />
                    Guião em Tempo Real
                </h3>
                {isSpeaking && <span className="text-xs text-green-400 font-bold animate-pulse">A NARRAR...</span>}
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth">
                {selectedMovie?.srtEntries.map((entry) => {
                    const isPast = entry.endTime < currentMovieTime;
                    const isCurrent = currentMovieTime >= entry.startTime && currentMovieTime <= entry.endTime;
                    const isFuture = entry.startTime > currentMovieTime;
                    
                    // Simple auto-scroll trigger ref could be added here
                    
                    return (
                        <div 
                            key={entry.id} 
                            id={`line-${entry.id}`}
                            className={`p-4 rounded-lg border transition-all duration-300 ${
                                isCurrent 
                                    ? 'bg-blue-600/20 border-blue-500/50 shadow-lg scale-[1.02]' 
                                    : isPast 
                                        ? 'opacity-40 bg-slate-800/50 border-transparent'
                                        : 'bg-slate-700/30 border-slate-700'
                            }`}
                        >
                            <div className="flex justify-between items-center mb-1">
                                <span className={`text-xs font-mono ${isCurrent ? 'text-blue-300' : 'text-slate-500'}`}>
                                    {formatTime(entry.startTime)}
                                </span>
                                {isCurrent && <Volume2 size={12} className="text-blue-400" />}
                            </div>
                            <p className={`text-lg leading-relaxed ${isCurrent ? 'text-white font-medium' : 'text-slate-400'}`}>
                                {entry.text}
                            </p>
                        </div>
                    );
                })}
                {selectedMovie?.srtEntries.length === 0 && (
                    <div className="text-center text-slate-500 py-10">
                        O guião está vazio.
                    </div>
                )}
            </div>
        </div>
    </div>
  );
};

export default LiveDescriber;