import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Download, TriangleAlert, Activity } from 'lucide-react';
import type { SpeakerLine, WordChunk } from '@/types/diarization';

interface SpeakerTranscriptProps {
  lines: SpeakerLine[];                         // final result (empty until the run finishes)
  liveWords: WordChunk[];                       // words streamed in while transcribing
  isRunning: boolean;
  speakerNames: Record<string, string>;         // label → name the user typed, e.g. SPEAKER_1 → "George"
  onRenameSpeaker: (label: string, name: string) => void;
}

interface LiveLine {
  start: number;
  text: string;
}

// One text colour per speaker, in order of first appearance
const SPEAKER_COLOURS = ['text-blue-600', 'text-emerald-600', 'text-amber-600', 'text-purple-600', 'text-rose-600'];

// "SPEAKER_1" → "Speaker 1"
const defaultName = (label: string) =>
  label.startsWith('SPEAKER_') ? `Speaker ${label.slice('SPEAKER_'.length)}` : label;

// Same mm:ss format as TranscriptionResults
const formatTimestamp = (timestamp: number) => {
  if (!isFinite(timestamp)) return '--:--';
  const minutes = Math.floor(timestamp / 60);
  const seconds = Math.floor(timestamp % 60);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

// Same rule as the worker's final pass: one word at most twice in a row.
// Stops Whisper loops like "[screaming] [screaming] [screaming]…" filling the live view.
const MAX_REPEATS = 2;
const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function collapseRepeats(words: WordChunk[]): WordChunk[] {
  const kept: WordChunk[] = [];
  let previous = '';
  let count = 0;
  for (const word of words) {
    const key = normalise(word.text);
    count = key !== '' && key === previous ? count + 1 : 1;
    previous = key;
    if (count <= MAX_REPEATS) kept.push(word);
  }
  return kept;
}

// While streaming, show sentences as timestamped lines, like the normal transcript
function toLiveLines(allWords: WordChunk[]): LiveLine[] {
  const words = collapseRepeats(allWords);
  const lines: LiveLine[] = [];
  let current: LiveLine | null = null;
  words.forEach((word, i) => {
    const start = word.timestamp[0];
    const end = word.timestamp[1] ?? start;
    if (!current) current = { start, text: '' };
    current.text += word.text;
    const next = words[i + 1];
    const endsSentence = /[.?!]["')\]]*$/.test(word.text.trim());
    const pauseAfter = next ? next.timestamp[0] - end : Infinity;
    const isCoarse = word.text.trim().includes(' ');
    if (!next || endsSentence || pauseAfter > 1.5 || isCoarse) {
      current.text = current.text.trim();
      if (current.text) lines.push(current);
      current = null;
    }
  });
  return lines;
}

export const SpeakerTranscript = ({
  lines,
  liveWords,
  isRunning,
  speakerNames,
  onRenameSpeaker
}: SpeakerTranscriptProps) => {
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Speakers in order of first appearance
  const speakers = useMemo(() => {
    const seen: string[] = [];
    for (const line of lines) if (!seen.includes(line.speaker)) seen.push(line.speaker);
    return seen;
  }, [lines]);

  // The name shown everywhere: what the user typed, otherwise "Speaker N"
  const nameOf = (label: string) => speakerNames[label]?.trim() || defaultName(label);
  const colourOf = (label: string) => SPEAKER_COLOURS[speakers.indexOf(label) % SPEAKER_COLOURS.length];

  const liveLines = useMemo(() => toLiveLines(liveWords), [liveWords]);
  const showFinal = lines.length > 0;
  const showLive = !showFinal && liveLines.length > 0;
  const isPartial = showLive;                 // exporting before speaker labels exist
  const canExport = showFinal || showLive;
  const fileSuffix = isPartial ? '-partial' : '';

  // Auto-scroll when a new line appears
  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [liveLines.length, lines.length]);

  const downloadFile = (content: string, fileName: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const showExportStatus = (message: string) => {
    setExportStatus(message);
    setTimeout(() => setExportStatus(null), 2000);
  };

  const exportTXT = () => {
    if (!canExport) return;
    let content: string;
    if (isPartial) {
      // Mark partial files so they are never mistaken for a full transcript
      const upTo = formatTimestamp(liveLines[liveLines.length - 1].start);
      content = `[Partial transcript: exported while transcribing, up to ${upTo}. No speaker labels yet]\n\n`
        + liveLines.map(l => `${formatTimestamp(l.start)}: ${l.text}`).join('\n');
    } else {
      content = lines.map(l => `${formatTimestamp(l.start)}: ${nameOf(l.speaker)}: ${l.text}`).join('\n');
    }
    downloadFile(content, `transcription-speakers${fileSuffix}.txt`, 'text/plain');
    showExportStatus(isPartial ? 'Partial TXT exported!' : 'TXT exported!');
  };

  const exportJSON = () => {
    if (!canExport) return;
    const data = isPartial
      ? { partial: true, segments: liveLines.map(l => ({ start: l.start, text: l.text })) }
      : {
          partial: false,
          speakers: Object.fromEntries(speakers.map(s => [s, nameOf(s)])),
          segments: lines.map(l => ({ start: l.start, end: l.end, speaker: nameOf(l.speaker), label: l.speaker, text: l.text }))
        };
    downloadFile(JSON.stringify(data, null, 2), `transcription-speakers${fileSuffix}.json`, 'application/json');
    showExportStatus(isPartial ? 'Partial JSON exported!' : 'JSON exported!');
  };

  return (
    <div className="space-y-0">
      {/* Speaker names: same box style as "Selected File". Edit once, every line updates. */}
      {showFinal && (
        <div className="bg-muted/50 rounded-lg p-4 space-y-2 mb-4">
          <span className="text-sm font-medium">Speakers:</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {speakers.map(label => (
              <div key={label} className="flex items-center gap-2">
                <span className={`text-sm font-medium min-w-[80px] ${colourOf(label)}`}>{defaultName(label)}</span>
                <Input
                  value={speakerNames[label] ?? ''}
                  placeholder="Type a name…"
                  onChange={e => onRenameSpeaker(label, e.target.value)}
                  className="h-8 text-sm"
                  aria-label={`Name for ${defaultName(label)}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <Card className="border-0 shadow-none">
        <div ref={containerRef} className="space-y-4 max-h-64 overflow-y-auto">
          {showFinal ? (
            lines.map((line, i) => (
              <div
                key={i}
                className="flex gap-3 opacity-0 animate-lineFade transcript-line"
                style={{ animationDelay: '0ms', animationFillMode: 'forwards' }}
              >
                <span className="text-timestamp text-sm font-mono min-w-[48px]">{formatTimestamp(line.start)}</span>
                <p className="text-foreground text-sm leading-relaxed">
                  <span className={`font-semibold ${colourOf(line.speaker)}`}>{nameOf(line.speaker)}:</span> {line.text}
                </p>
              </div>
            ))
          ) : showLive ? (
            liveLines.map((line, i) => (
              <div
                key={i}
                className="flex gap-3 opacity-0 animate-lineFade transcript-line"
                style={{ animationDelay: '0ms', animationFillMode: 'forwards' }}
              >
                <span className="text-timestamp text-sm font-mono min-w-[48px]">{formatTimestamp(line.start)}</span>
                <p className="text-foreground text-sm leading-relaxed">{line.text}</p>
              </div>
            ))
          ) : (
            <p className="text-center text-sm text-gray-500 p-4">
              {isRunning ? (
                <span><Activity className="h-4 w-4 mr-1 ml-1 inline-flex" /> Transcribing...</span>
              ) : (
                <span><TriangleAlert className="h-4 w-4 mr-1 ml-1 inline-flex" /> No transcription yet</span>
              )}
            </p>
          )}
        </div>
      </Card>

      <div className="pt-4 flex gap-3 justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={exportTXT}
          disabled={!canExport}
          className="bg-export-success border-export-success transition-all duration-200 hover:bg-teal-300 hover:scale-105 disabled:opacity-50"
        >
          <Download className="h-4 w-4 mr-2" />
          {isPartial ? 'Export TXT (so far)' : 'Export TXT'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={exportJSON}
          disabled={!canExport}
          className="bg-export-success border-export-success transition-all duration-200 hover:bg-teal-300 hover:scale-105 disabled:opacity-50"
        >
          <Download className="h-4 w-4 mr-2" />
          {isPartial ? 'Export JSON (so far)' : 'Export JSON'}
        </Button>
      </div>

      {exportStatus && (
        <p className="text-sm text-export-success text-center">{exportStatus}</p>
      )}
    </div>
  );
};