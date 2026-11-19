import { LoaderCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

interface TranscriptionProgressProps {
  title: string;              // e.g. "Transcribing audio"
  step?: string;              // e.g. "Step 1 of 2"; speaker mode only
  done: number;               // seconds of audio processed
  total: number;              // length of the audio in seconds
  note?: string;              // extra line under the bar
  barClassName?: string;      // colour of the filled part
}

const formatTime = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mmss = `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
};

// Shows how far through the recording the current step is, e.g. "12:30 / 49:19 · 25%"
export const TranscriptionProgress = ({ title, step, done, total, note, barClassName }: TranscriptionProgressProps) => {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <Card className="p-4 space-y-2 bg-muted/50" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
          {step && <span className="text-muted-foreground font-normal">{step} ·</span>}
          {title}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {formatTime(done)} / {formatTime(total)} · {percent}%
        </span>
      </div>
      <Progress
        value={percent}
        className="h-2"
        aria-label={`${title}: ${percent}%`}
        indicatorClassName={barClassName}
      />
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </Card>
  );
};
