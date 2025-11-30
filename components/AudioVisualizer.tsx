import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  isActive: boolean;
  isSpeaking: boolean;
  stream?: MediaStream;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ isActive, isSpeaking, stream }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  useEffect(() => {
    if (!isActive || !stream || !canvasRef.current) return;

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    
    analyserRef.current = analyser;
    sourceRef.current = source;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!ctx || !canvas) return;
      
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2;

        // Dynamic color based on speaking state
        if (isSpeaking) {
             ctx.fillStyle = `rgb(${barHeight + 100}, 50, 50)`; // Red/Pink tint when AI speaks (simulated via state props, though strictly this visualizer is showing INPUT mic)
        } else {
             ctx.fillStyle = `rgb(50, ${barHeight + 100}, 255)`; // Blue tint for listening
        }
        
        // Visual tweak: if isSpeaking is true, we might want to override the visualizer to simulate output wave
        // But for this simple version, let's stick to visualizing the Input to show "Listening"
        
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    };

    draw();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      source.disconnect();
      audioContext.close();
    };
  }, [isActive, stream, isSpeaking]);

  return (
    <div className="w-full h-32 bg-slate-800 rounded-lg overflow-hidden relative shadow-inner">
        {!isActive && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                <span className="text-sm uppercase tracking-widest font-semibold">Aguardando Início</span>
            </div>
        )}
      <canvas 
        ref={canvasRef} 
        width={300} 
        height={128} 
        className={`w-full h-full ${isActive ? 'opacity-100' : 'opacity-0'} transition-opacity duration-500`} 
      />
    </div>
  );
};

export default AudioVisualizer;