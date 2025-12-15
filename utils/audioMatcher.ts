
// Configuração do Fingerprint
const TARGET_SAMPLE_RATE = 20; // 20Hz (Resolução de 50ms) para maior precisão
const WINDOW_SIZE_SEC = 6; // Aumentado para 6s para ter mais "assinatura" única
const MIN_RMS_THRESHOLD = 0.005; // Mínimo de energia para considerar sinal válido (evita silêncio)
const MIN_VARIANCE_THRESHOLD = 0.0005; // Mínimo de variação para evitar ruído constante

export interface MatchResult {
  currentTime: number; // Tempo exato ATUAL (Fim da janela de match)
  confidence: number;  // 0 a 100% (Baseado em correlação)
}

/**
 * Classe responsável por criar e comparar modelos matemáticos de áudio usando Correlação.
 */
export class AudioMatcher {
  private masterEnvelope: Float32Array | null = null;
  private duration: number = 0;

  /**
   * Processa o ficheiro de áudio completo para criar a "Matriz de Energia".
   * Normaliza para 20Hz.
   */
  generateMasterFingerprint(audioBuffer: AudioBuffer): void {
    this.duration = audioBuffer.duration;
    this.masterEnvelope = this.extractEnvelope(audioBuffer);
    console.log(`[AudioMatcher] Matriz (Envelope) gerada. Duração: ${this.duration.toFixed(1)}s. Samples: ${this.masterEnvelope.length}`);
  }

  /**
   * Extrai o envelope de energia (Amplitude RMS) reamostrado para TARGET_SAMPLE_RATE.
   */
  private extractEnvelope(buffer: AudioBuffer): Float32Array {
    const pcm = buffer.getChannelData(0); // Mono
    const srcRate = buffer.sampleRate;
    
    // Total de pontos no envelope final
    const totalPoints = Math.floor(this.duration * TARGET_SAMPLE_RATE);
    const envelope = new Float32Array(totalPoints);
    
    // Quantos samples originais correspondem a 1 ponto de envelope (Ex: 44100 / 20 = 2205)
    const step = Math.floor(srcRate / TARGET_SAMPLE_RATE);

    for (let i = 0; i < totalPoints; i++) {
      const start = i * step;
      const end = Math.min(start + step, pcm.length);
      
      let sum = 0;
      // Cálculo RMS (Root Mean Square) para energia real
      for (let j = start; j < end; j++) {
        sum += pcm[j] * pcm[j];
      }
      // Raiz quadrada da média
      envelope[i] = Math.sqrt(sum / (end - start));
    }
    
    return envelope;
  }

  /**
   * Processa o buffer "Live" do microfone.
   * IMPORTANTE: O buffer recebido pode ter sampleRate diferente da Matriz, mas aqui normalizamos.
   */
  createLiveFingerprint(pcmData: Float32Array, sampleRate: number): Float32Array {
      const duration = pcmData.length / sampleRate;
      const totalPoints = Math.floor(duration * TARGET_SAMPLE_RATE);
      const envelope = new Float32Array(totalPoints);
      const step = Math.floor(sampleRate / TARGET_SAMPLE_RATE);

      for (let i = 0; i < totalPoints; i++) {
          const start = i * step;
          const end = Math.min(start + step, pcmData.length);
          let sum = 0;
          for (let j = start; j < end; j++) {
             sum += pcmData[j] * pcmData[j];
          }
          envelope[i] = Math.sqrt(sum / (end - start));
      }
      return envelope;
  }

  /**
   * Procura o padrão Live dentro da Matriz usando Correlação de Pearson.
   * Robusto a diferenças de volume e offset DC.
   * @param searchHintTime -1 para Scan Global (filme todo)
   */
  findMatch(liveEnvelope: Float32Array, searchHintTime: number = -1, scanWidthSeconds: number = 120): MatchResult {
    if (!this.masterEnvelope || liveEnvelope.length < (TARGET_SAMPLE_RATE * 2)) {
        return { currentTime: 0, confidence: 0 };
    }

    const N = liveEnvelope.length;
    const M = this.masterEnvelope.length;

    // Pré-calcular estatísticas do Live Vector (para Pearson)
    let sumL = 0, sumSqL = 0;
    for (let i = 0; i < N; i++) {
        sumL += liveEnvelope[i];
        sumSqL += liveEnvelope[i] * liveEnvelope[i];
    }
    const meanL = sumL / N;
    // Denominador parte L: Sqrt(Sum(Li - meanL)^2) = Sqrt(SumSqL - N*meanL^2)
    // Variance check: (SumSqL/N - meanL^2) is variance.
    const varianceL = (sumSqL / N) - (meanL * meanL);
    const rmsL = Math.sqrt(sumSqL / N);

    // ENERGY GATE: Se o sinal for muito fraco ou muito plano (silêncio/ruído constante), abortar.
    if (rmsL < MIN_RMS_THRESHOLD || varianceL < MIN_VARIANCE_THRESHOLD) {
        // console.log("Sinal ignorado (Silêncio/Ruído fraco)", rmsL, varianceL);
        return { currentTime: 0, confidence: 0 };
    }

    const denL = Math.sqrt(Math.max(0, sumSqL - N * meanL * meanL));

    if (denL === 0) return { currentTime: 0, confidence: 0 }; 

    // Definir limites de busca
    let startIdx = 0;
    let endIdx = M - N;

    // Se hint for >= 0 e width > 0, fazemos busca local. Se não, busca global.
    if (searchHintTime >= 0 && scanWidthSeconds > 0) {
        const hintIdx = Math.floor(searchHintTime * TARGET_SAMPLE_RATE);
        const widthIdx = Math.floor(scanWidthSeconds * TARGET_SAMPLE_RATE);
        
        // O hintIdx é onde achamos que estamos AGORA (fim do match).
        // O startIdx é onde começa a comparação na matriz (início do match).
        const targetStartIdx = hintIdx - N;
        
        startIdx = Math.max(0, targetStartIdx - widthIdx);
        endIdx = Math.min(M - N, targetStartIdx + widthIdx);
    }

    let maxCorr = -1;
    let bestStartIdx = -1;

    // Loop de Correlação Deslizante
    // Removida otimização de step para garantir precisão máxima no scan global
    const step = 1;

    for (let i = startIdx; i < endIdx; i += step) {
        let sumM = 0;
        let sumSqM = 0;
        let crossSum = 0;

        // Loop interno (N iterações - ex: 5s * 20Hz = 100 pontos)
        for (let j = 0; j < N; j++) {
            const valM = this.masterEnvelope[i + j];
            const valL = liveEnvelope[j];
            
            sumM += valM;
            sumSqM += valM * valM;
            crossSum += valM * valL;
        }

        const meanM = sumM / N;
        const denM = Math.sqrt(Math.max(0, sumSqM - N * meanM * meanM));

        if (denM > 0) {
            // Pearson r = Cov(L, M) / (StdL * StdM)
            const cov = crossSum - (N * meanL * meanM);
            const r = cov / (denL * denM);

            if (r > maxCorr) {
                maxCorr = r;
                bestStartIdx = i;
            }
        }
    }

    // Calcular tempo final
    const matchEndTime = (bestStartIdx + N) / TARGET_SAMPLE_RATE;

    return {
        currentTime: matchEndTime,
        confidence: Math.max(0, maxCorr * 100) // Pearson r (-1 a 1) -> %
    };
  }
}