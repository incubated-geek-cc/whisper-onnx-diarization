import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Download, TriangleAlert, Activity } from 'lucide-react';
import type { TranscriptionResult, TranscriptionSegment } from '@/types/whisper';

interface TranscriptionResultsProps {
  result: TranscriptionResult | null;
  isTranscribing: boolean;
  segments: TranscriptionSegment[];
}

export const TranscriptionResults = ({ result, isTranscribing, segments }: TranscriptionResultsProps) => {
  const [renderedLines, setRenderedLines] = useState<TranscriptionSegment[]>([]);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll when a new line appears
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [renderedLines]);

  useEffect(() => {
    if (segments.length === 0) {
      setRenderedLines([]);          // new run started: clear the old lines
      return;
    }
    if (segments.length > renderedLines.length) {
      const newChunks = segments.slice(renderedLines.length);
      setRenderedLines(prev => [...prev, ...newChunks]);
    }
  }, [segments]);

  const formatTimestamp = (timestamp: number) => {
    if (!isFinite(timestamp)) return '--:--';
    const minutes = Math.floor(timestamp / 60);
    const seconds = Math.floor(timestamp % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  // What to export: the finished result when there is one,
  // otherwise the lines received so far (partial export while transcribing).
  const exportChunks: TranscriptionSegment[] = result?.chunks?.length ? result.chunks : segments;
  const isPartial = !result && segments.length > 0;
  const canExport = !!result || segments.length > 0;
  const fileSuffix = isPartial ? '-partial' : '';

  const showExportStatus = (message: string) => {
    setExportStatus(message);
    setTimeout(() => setExportStatus(null), 2000);
  };

  const downloadFile = (content: string, fileName: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportTXT = () => {
    if (!canExport) return;
    let content = exportChunks.length > 0
      ? exportChunks.map(chunk => `${formatTimestamp(chunk.timestamp[0])}: ${chunk.text.trim()}`).join('\n')
      : result?.text ?? '';
    if (isPartial) {
      // Mark partial files so they are never mistaken for a full transcript
      const upTo = formatTimestamp(exportChunks[exportChunks.length - 1].timestamp[1] ?? exportChunks[exportChunks.length - 1].timestamp[0]);
      content = `[Partial transcript: exported while transcribing, up to ${upTo}]\n\n` + content;
    }
    downloadFile(content, `transcription${fileSuffix}.txt`, 'text/plain');
    showExportStatus(isPartial ? 'Partial TXT exported!' : 'TXT exported!');
  };

  const exportJSON = () => {
    if (!canExport) return;
    const jsonData = {
      partial: isPartial,
      text: exportChunks.length > 0
        ? exportChunks.map(chunk => chunk.text.trim()).join(' ')
        : result?.text ?? '',
      segments: exportChunks.map(chunk => ({
        start: chunk.timestamp[0],
        end: chunk.timestamp[1],
        text: chunk.text.trim()
      }))
    };
    downloadFile(JSON.stringify(jsonData, null, 2), `transcription${fileSuffix}.json`, 'application/json');
    showExportStatus(isPartial ? 'Partial JSON exported!' : 'JSON exported!');
  };

  return (
      <div className="space-y-0">
        <Card className="border-0 shadow-none">
          <div ref={containerRef} className="space-y-4 max-h-64 overflow-y-auto">
             {
              segments.length > 0 ? 
              renderedLines.map((chunk, i) => (
                <div
                  key={i}
                  className='flex gap-3 opacity-0 animate-lineFade transcript-line'
                  style={{ animationDelay: '0ms', animationFillMode: 'forwards' }}
                >
                  <span className="text-timestamp text-sm font-mono min-w-[48px]">{formatTimestamp(chunk.timestamp[0])}</span>
                  <p className="text-foreground text-sm leading-relaxed">{chunk.text.trim()}</p>
                </div>
              )) : 
              (
                <p className="text-center text-sm text-gray-500 p-4">
                  {isTranscribing ? (
                    <span><Activity className="h-4 w-4 mr-1 ml-1 inline-flex" /> Transcribing...</span>
                  ) : (
                    <span><TriangleAlert className="h-4 w-4 mr-1 ml-1 inline-flex" /> No transcription yet</span>
                  )}
                </p>
              )
             }
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
