import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  isActive: boolean;
  isSpeaking: boolean;
  isMicMuted?: boolean;
  analyser: AnalyserNode | null;
  label?: string;
  colorTheme?: 'blue' | 'green' | 'purple';
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ 
    isActive, 
    isSpeaking, 
    isMicMuted, 
    analyser, 
    label,
    colorTheme = 'blue' 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // If analyser exists, we draw
    if (!analyser || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (isMicMuted) {
          drawMutedState(ctx, canvas);
          return;
      }

      // Check context state carefully. Some browsers don't expose 'suspended' on the node context directly depending on graph
      if (analyser.context.state === 'suspended') {
          drawSuspendedState(ctx, canvas);
          return;
      }

      drawBars(ctx, canvas, dataArray, bufferLength, isSpeaking, colorTheme);
    };

    draw();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [analyser, isSpeaking, isMicMuted, colorTheme]);

  const drawMutedState = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
      ctx.beginPath();
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      ctx.fillStyle = '#ef4444';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText("ÁUDIO DESATIVADO", canvas.width / 2, canvas.height / 2 - 10);
  };

  const drawSuspendedState = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
      ctx.fillStyle = '#eab308';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText("ÁUDIO SUSPENSO", canvas.width / 2, canvas.height / 2);
  };

  const drawBars = (
      ctx: CanvasRenderingContext2D, 
      canvas: HTMLCanvasElement, 
      dataArray: Uint8Array, 
      bufferLength: number,
      isSpeaking: boolean,
      theme: string
  ) => {
      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      // Color config
      let baseR = 50, baseG = 50, baseB = 255; // Blue default
      if (theme === 'green') { baseR=50; baseG=255; baseB=100; }
      if (theme === 'purple') { baseR=200; baseG=50; baseB=255; }

      for (let i = 0; i < bufferLength; i++) {
        const val = dataArray[i];
        barHeight = Math.max(val / 1.5, val > 5 ? 5 : 0); 

        if (isSpeaking && theme === 'blue') {
             // Speaking override usually only for Mic
             ctx.fillStyle = `rgba(${barHeight + 100}, 50, 50, 0.8)`;
        } else {
             const opacity = Math.max(0.3, barHeight / 100);
             ctx.fillStyle = `rgba(${baseR}, ${baseG}, ${baseB}, ${opacity})`; 
        }

        ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }
  };

  const isVisible = !!analyser;

  return (
    <div className="w-full h-32 bg-slate-950 rounded-lg overflow-hidden relative shadow-inner border border-slate-800">
        {label && (
            <div className="absolute top-2 left-2 z-20 px-2 py-1 bg-black/50 backdrop-blur rounded text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                {label}
            </div>
        )}
        <div className="absolute inset-0 opacity-10" 
             style={{backgroundImage: 'linear-gradient(to right, #334155 1px, transparent 1px), linear-gradient(to bottom, #334155 1px, transparent 1px)', backgroundSize: '20px 20px'}}>
        </div>

        {!isVisible && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 z-10">
                <span className="text-sm uppercase tracking-widest font-semibold bg-slate-900/80 px-4 py-2 rounded-lg backdrop-blur-sm">
                    A aguardar sinal...
                </span>
            </div>
        )}
        
      <canvas 
        ref={canvasRef} 
        width={300} 
        height={128} 
        className={`w-full h-full relative z-10 ${isVisible ? 'opacity-100' : 'opacity-0'} transition-opacity duration-500`} 
      />
    </div>
  );
};

export default AudioVisualizer;