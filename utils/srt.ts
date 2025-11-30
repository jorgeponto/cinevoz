export interface SrtEntry {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
}

/**
 * Parses a standard SRT string into structured data.
 */
export function parseSRT(data: string): SrtEntry[] {
  // Normalize line endings
  const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split('\n\n');
  const entries: SrtEntry[] = [];

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    // Line 1: ID
    const id = lines[0].trim();
    
    // Line 2: Timecode (00:00:00,000 --> 00:00:00,000)
    const timeLine = lines[1].trim();
    const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    
    if (timeMatch) {
      // Remaining lines: Text (can be multi-line)
      const text = lines.slice(2).join(' ').replace(/<[^>]*>/g, ''); // Join and strip HTML tags

      entries.push({
        id,
        startTime: parseTime(timeMatch[1]),
        endTime: parseTime(timeMatch[2]),
        text: text
      });
    }
  }
  return entries;
}

/**
 * Converts SRT timestamp (00:00:00,000) to seconds.
 */
function parseTime(timeStr: string): number {
  const [hms, ms] = timeStr.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return (h * 3600) + (m * 60) + s + (parseInt(ms, 10) / 1000);
}

/**
 * Formats seconds into HH:MM:SS
 */
export function formatTime(seconds: number): string {
  if (!seconds && seconds !== 0) return "--:--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}