import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Link } from 'lucide-react';

interface URLInputProps {
  onAudioLoad: (audioUrl: string) => Promise<void>;
  disabled?: boolean;
  value?: string;                       // optional: lets the page keep the URL when switching tabs
  onChange?: (value: string) => void;
}

export const URLInput = ({ onAudioLoad, disabled, value, onChange }: URLInputProps) => {
  const [localUrl, setLocalUrl] = useState('');
  const url = value ?? localUrl;
  const setUrl = onChange ?? setLocalUrl;
  const [isLoading, setIsLoading] = useState(false);

  const handleLoad = async () => {
    if (!url.trim()) return;
    
    setIsLoading(true);
    try {
      // Validate URL and check if it's accessible
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok) {
        await onAudioLoad(url);
      } else {
        throw new Error('Video/Audio file not accessible');
      }
    } catch (error) {
      console.error('Failed to load video/audio from URL:', error);
      alert('Failed to load video/audio from URL. Please check the URL and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Link className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="url"
            placeholder="https://example.com/audio.mp3"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="pl-10"
            disabled={disabled || isLoading}
          />
        </div>
        <Button 
          onClick={handleLoad}
          disabled={!url.trim() || disabled || isLoading}
          className="px-6"
        >
          {isLoading ? 'Loading...' : 'Load'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Enter a direct URL to a video/audio file (MP3, WAV, M4A, etc.)
      </p>
    </div>
  );
};