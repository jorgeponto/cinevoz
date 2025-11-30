import React from 'react';
import LiveDescriber from './components/LiveDescriber';
import { Eye, Film } from 'lucide-react';

const App: React.FC = () => {
  // Normally we wouldn't hardcode this check in the UI, but per instructions we assume it's in env
  const hasKey = !!process.env.API_KEY;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans selection:bg-blue-500/30">
      
      {/* Header */}
      <header className="bg-slate-950 border-b border-slate-800 p-4 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg">
                <Film className="text-white" size={24} />
            </div>
            <div>
                <h1 className="text-xl font-bold tracking-tight text-white leading-none">CineVoz</h1>
                <p className="text-xs text-slate-400 font-medium">Audiodescrição Inteligente</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-slate-400 text-sm">
             <Eye size={16} />
             <span className="hidden sm:inline">Acessibilidade Visual</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="mb-8 text-center space-y-2">
            <h2 className="text-2xl md:text-3xl font-bold text-white">Sincronize sua experiência</h2>
            <p className="text-slate-400 max-w-lg mx-auto">
                O CineVoz ouve o filme ou série que está a ver e gera descrições detalhadas em tempo real para enriquecer a sua experiência.
            </p>
        </div>

        {hasKey ? (
            <LiveDescriber apiKey={process.env.API_KEY as string} />
        ) : (
            <div className="max-w-md mx-auto bg-yellow-900/20 border border-yellow-700/50 p-6 rounded-xl text-center">
                <h3 className="text-lg font-bold text-yellow-500 mb-2">Chave API Ausente</h3>
                <p className="text-slate-300">
                    Por favor, configure a chave API no ambiente para utilizar o serviço de audiodescrição.
                </p>
            </div>
        )}

      </main>
      
      <footer className="py-6 text-center text-slate-600 text-sm border-t border-slate-800 mt-auto">
        <p>Desenvolvido com Gemini Live API • Acessibilidade para Todos</p>
      </footer>
    </div>
  );
};

export default App;