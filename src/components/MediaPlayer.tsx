import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Play, Pause, Volume2, MoreHorizontal, Download } from 'lucide-react';

interface MediaPlayerProps {
  src?: string;
  audioBlob?: Blob;
  isVideo?: boolean;                                   // NEW: show <video> instead of <audio>
}

export const MediaPlayer = ({ src, audioBlob, isVideo }: MediaPlayerProps) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [duration, setDuration] = useState(0);
  const mediaRef = useRef<HTMLMediaElement>(null);

  useEffect(() => {
    setIsPlaying(false);                               // NEW: a new file starts paused
    setCurrentTime(0);                                 // NEW
    if (audioBlob && mediaRef.current) {
      const url = URL.createObjectURL(audioBlob);
      mediaRef.current.src = url;
      return () => URL.revokeObjectURL(url);
    } else if (src && mediaRef.current) {
      mediaRef.current.src = src;
    }
  }, [src, audioBlob, isVideo]);

  const togglePlayPause = () => {
    if (mediaRef.current) {
      if (isPlaying) {
        mediaRef.current.pause();
      } else {
        mediaRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };


  const handleTimeUpdate = () => {
    if (mediaRef.current) {
      setCurrentTime(mediaRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (mediaRef.current) {
      setDuration(mediaRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (mediaRef.current) {
      mediaRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const handleVolumeChange = (values: number[]) => {
    const newVolume = values[0];
    setVolume(newVolume);
    if (mediaRef.current) {
      mediaRef.current.volume = newVolume;
    }
  };

  const handleDownload = () => {
    if (audioBlob) {
      const url = URL.createObjectURL(audioBlob);
      const a = document.createElement('a');
      a.href = url;
      // CHANGED: keep the original file name (e.g. "EP.7.mp4") when there is one
      a.download = audioBlob instanceof File ? audioBlob.name : 'audio.wav';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else if (src) {
      const a = document.createElement('a');
      a.href = src;
      a.download = 'audio';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);

    return ( (!isFinite(time) || isNaN(time)) ? '00:00' : `${minutes}:${seconds.toString().padStart(2, '0')}` );
  };

  if (!src && !audioBlob) {
    return null;
  }

  return (
    // CHANGED: wider box for video
    <div className={`w-full ${isVideo ? 'max-w-2xl' : 'max-w-md'} mx-auto bg-card rounded-lg p-4 shadow-sm`}>
      {isVideo ? (
        // NEW: video element, click the picture to play/pause
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={() => setIsPlaying(false)}
          onClick={togglePlayPause}
          playsInline
          className="w-full max-h-[360px] rounded-md bg-black mb-3 cursor-pointer"
        />
      ) : (
        <audio
          ref={mediaRef as React.RefObject<HTMLAudioElement>}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={() => setIsPlaying(false)}
        />
      )}
      
        <div className="flex items-center space-x-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={togglePlayPause}
            className="h-8 w-8 p-0"
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          
          <span className="text-sm text-muted-foreground min-w-[40px]">
            {formatTime(currentTime)}
          </span>
          
          <Input
              type="range"
              min={0}
              max={duration || 0}
              value={currentTime}
              onChange={handleSeek}
              className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer slider px-1"
              style={{
                background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${(currentTime / duration) * 100}%, hsl(var(--muted)) ${(currentTime / duration) * 100}%, hsl(var(--muted)) 100%)`
              }}
            />
        
            <span className="text-sm text-muted-foreground min-w-[40px]">
              {formatTime(duration)}
            </span>
            

            {/* Volume control wrapper */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <Volume2 className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-32 p-2">
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Volume</p>
                  <Slider
                    value={[volume]}
                    onValueChange={handleVolumeChange}
                    max={1}
                    min={0}
                    step={0.01}
                    className="w-full"
                  />
                  <p className="text-xs text-center">{Math.round(volume * 100)}%</p>
                </div>
              </PopoverContent>
            </Popover>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-2" />
                  Download Media
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            
        </div>
      </div>
  );
};