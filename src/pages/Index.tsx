import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Settings, Loader2, LoaderCircle, Heart, Github, PencilLine, FileText, Users } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { TabNavigation, TabType } from '@/components/TabNavigation';
import { URLInput } from '@/components/URLInput';
import { FileInput } from '@/components/FileInput';
import { RecordInput } from '@/components/RecordInput';
import { MediaPlayer } from '@/components/MediaPlayer';
import { TranscriptionResults } from '@/components/TranscriptionResults';
import { SpeakerTranscript } from '@/components/SpeakerTranscript';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TranscriptionProgress } from '@/components/TranscriptionProgress';
import { ModelSelector } from '@/components/ModelSelector';
import { useWhisperWorker } from '@/hooks/useWhisperWorker';
import { useDiarizationWorker } from '@/hooks/useDiarizationWorker';
import { DEFAULT_MODELS, DEFAULT_MODEL_KEY } from '@/lib/models';
import type { TranscriptionResult } from '@/types/whisper';
import { useToast } from '@/hooks/use-toast';
import { Toaster } from '@/components/ui/toaster';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

export const Index = () => {
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [identifySpeakers, setIdentifySpeakers] = useState(false);
  const [numSpeakers, setNumSpeakers] = useState<number>(0);   // 0 = work it out automatically
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});   // SPEAKER_1 → "George"

  const [activeTab, setActiveTab] = useState<TabType>('url');
  const [audioSrc, setAudioSrc] = useState<string>('');
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionResult | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string>(DEFAULT_MODEL_KEY);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isConverting, setIsConverting] = useState(false);

  // Persistent tab states
  const [urlInputValue, setUrlInputValue] = useState('');
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileDetails, setFileDetails] = useState<{
    name: string;
    size: string;
    duration?: string;
  } | null>(null);

  const { toast } = useToast();

  const {
    isLoading,
    isReady,
    isTranscribing,
    segments,
    loadingProgress,
    error,
    currentModel,
    device,
    progress,
    initializeWorker,
    configureModel,
    loadModel,
    transcribe,
    cleanup
  } = useWhisperWorker();

  const diarization = useDiarizationWorker();
  useEffect(() => diarization.cleanup, [diarization.cleanup]);   // stop the worker when the page closes

  useEffect(() => {
    initializeWorker();
    return cleanup;
  }, [initializeWorker, cleanup]);
  // Prevent navigation during transcription

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'You may lose unsaved changes including recordings, processed audio and transcription results. Are you sure you want to leave?';
      return 'You may lose unsaved changes including recordings, processed audio and transcription results. Are you sure you want to leave?';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  const handleModelChange = (modelKey: string) => {
    setSelectedModelKey(modelKey);
    const modelConfig = DEFAULT_MODELS[modelKey];
    if (modelConfig) {
      configureModel(modelConfig);
    }
  };

  const handleLoadModel = () => {
    loadModel();
    setIsSettingsOpen(false);
  };

  const handleAudioLoad = async (url: string) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      // Use the last part of the URL as the filename, e.g. "talk.mp4"
      const name = new URL(url).pathname.split('/').pop() || 'download';
      const file = new File([blob], name, { type: blob.type });
      await handleFileSelect(file);   // same path as an uploaded file
    } catch (error) {
      console.error('Failed to download media:', error);
      toast({
        title: 'Download failed',
        description: 'Could not fetch the file from that URL',
        variant: 'destructive'
      });
    }
  };

  // FFmpeg is loaded once and reused for every file (loading it takes a few seconds)
  const ffmpegRef = useRef<Promise<FFmpeg> | null>(null);
  const getFFmpeg = () => {
    if (!ffmpegRef.current) {
      ffmpegRef.current = (async () => {
        const ffmpeg = new FFmpeg();
        // Load FFmpeg's core from public/ffmpeg, never from the CDN
        await ffmpeg.load({
          coreURL: await toBlobURL('/ffmpeg/ffmpeg-core.js', 'text/javascript'),
          wasmURL: await toBlobURL('/ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
        });
        return ffmpeg;
      })();
      ffmpegRef.current.catch(() => { ffmpegRef.current = null; });   // failed load: try again next time
    }
    return ffmpegRef.current;
  };

  // Returns the 16 kHz mono WAV, or null (with an error message) if conversion fails
  const handleWAVConversion = async (input: Blob | File): Promise<Blob | null> => {
    setIsConverting(true);
    const inputName = input instanceof File ? input.name : 'input.webm';
    const outputName = 'output.wav';
    try {
      const ffmpeg = await getFFmpeg();
      await ffmpeg.writeFile(inputName, new Uint8Array(await input.arrayBuffer()));
      const exitCode = await ffmpeg.exec([
        '-y',                // overwrite output.wav left from the previous file
        '-i', inputName,
        '-vn',               // drop the video track, keep audio only
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        outputName
      ]);
      if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);
      const wavData = await ffmpeg.readFile(outputName);
      // Free FFmpeg's in-memory files so they don't pile up across uploads
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(outputName).catch(() => {});
      return new Blob([(wavData as Uint8Array).slice()], { type: 'audio/wav' });   // .slice(): a plain ArrayBuffer copy, which Blob accepts
    } catch (error) {
      console.error('Audio conversion failed:', error);
      toast({
        title: 'Conversion failed',
        description: 'Could not extract audio from this file. Try another format.',
        variant: 'destructive'
      });
      return null;
    } finally {
      setIsConverting(false);
    }
  };

  // Set file details
  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };
  
  const handleFileSelect = async(file: File) => {
    setSelectedFile(file);
    setFileDetails({
      name: file.name,
      size: formatFileSize(file.size)
    });

    let wav: Blob | null;
    if (!file.name.toLowerCase().endsWith('.wav')) {
      wav = await handleWAVConversion(file);
      if (!wav) return;         // conversion failed, the error message is already shown
      setTranscriptionResult(null);
      toast({
        title: 'Audio processed',
        description: 'File converted to compatible format'
      });
    } else {
      wav = file;               // already a WAV, use it directly
    }
    setAudioBlob(wav);          // ← what gets transcribed
    setAudioSrc(URL.createObjectURL(wav));
    setMediaFile(file);         // ← what gets played (original, may be video)
  };

  const handleRecordingComplete = async (blob: Blob) => {
    const wavBlob = await handleWAVConversion(blob);
    if (!wavBlob) return;
    setAudioBlob(wavBlob);
    setAudioSrc(URL.createObjectURL(wavBlob));
    setMediaFile(null);
    setTranscriptionResult(null);
  };

  const handleTranscribe = async () => {
    if (identifySpeakers ? !diarization.isReady : !isReady) return;
    try {
      let arrayBuffer: ArrayBuffer;
      if (audioBlob) {
        arrayBuffer = await audioBlob.arrayBuffer();
      } else if (audioSrc) {
        const response = await fetch(audioSrc);
        arrayBuffer = await response.arrayBuffer();
      } else {
        return;
      }
      setTranscriptionResult(null);

      const audioContext = new AudioContext({ sampleRate: 16000 });
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const pcmData = audioBuffer.getChannelData(0);

      const ratio = audioBuffer.sampleRate / 16000;
      let monoData = pcmData;
      if (ratio !== 1) {
        const newLength = Math.floor(pcmData.length / ratio);
        monoData = new Float32Array(newLength);
        for (let i = 0; i < newLength; i++) {
          monoData[i] = pcmData[Math.floor(i * ratio)];
        }
      }

      if (identifySpeakers) {
        setSpeakerNames({});   // new run: start again from "Speaker 1, 2, 3"
        const lines = await diarization.transcribe(monoData.buffer, numSpeakers || undefined);
        toast({ title: 'Speakers identified', description: `${lines.length} lines. Rename speakers above the transcript.` });
        return;
      }
      const result = await transcribe(monoData.buffer);
      if (result) setTranscriptionResult(result);
    } catch (error) {
      console.error('Transcription failed:', error);
      toast({
        title: 'Processing failed',
        description: 'Failed to process audio file',
        variant: 'destructive'
      });
    }
  };

  const chooseMode = (speakers: boolean) => {
    setIdentifySpeakers(speakers);
    if (speakers && !diarization.isReady && !diarization.isLoading) diarization.loadModels();
  };
  const isBusy = isTranscribing || diarization.isTranscribing;

  // Status of whichever models the chosen mode will use
  const modeStatus = identifySpeakers
    ? diarization.isLoading ? 'Loading speaker models…'
      : diarization.isReady ? `Speaker models ready${diarization.device ? ` on ${diarization.device.toUpperCase()}` : ''}`
      : 'Speaker models not loaded'
    : isLoading ? `Loading ${currentModel?.name ?? 'Whisper model'}…`
      : isReady ? `${currentModel?.name ?? 'Whisper model'} ready${device ? ` on ${device.toUpperCase()}` : ''}`
      : 'Model not loaded';

  const hasAudio = audioSrc || audioBlob;
  const canTranscribe = hasAudio && (identifySpeakers
    ? diarization.isReady && !diarization.isTranscribing
    : isReady && !isTranscribing);
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-4xl px-4 py-8">
        {/* Header */}
        <div className="relative text-center mb-8">
          <h1 className="text-5xl font-bold text-foreground mb-2">
            Whisper Web
          </h1>
          <p className="text-xl text-muted-foreground">
            ML-powered speech recognition directly in your browser
          </p>
          <div className="absolute top-0 right-0">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <Heart className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-3">
                <div className="space-y-2">
                  <a
                    href="https://www.buymeacoffee.com/geekcc"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted transition-colors text-sm"
                  >
                    <Heart className="h-4 w-4 text-red-500" /> Buy Me a 🌮Taco
                  </a>
                  <a
                    href="https://github.com/incubated-geek-cc"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted transition-colors text-sm"
                  >
                    <Github className="h-4 w-4" /> View on GitHub
                  </a>
                  <a
                    href="https://geek-cc.medium.com/adab61be7af7"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted transition-colors text-sm"
                  >
                    <PencilLine className="h-4 w-4" /> Read on Medium
                  </a>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Loading Status */}
        {isLoading && (
          <Card className="p-6 mb-6 bg-muted/50">
            <div className="flex items-center justify-center space-x-3">
              <Loader2 className="h-5 w-5 animate-spin" />
              <div className="text-sm">
                {loadingProgress ? (
                  <span>
                    {loadingProgress.status}: {Math.round(loadingProgress.progress)}%
                    {loadingProgress.file && (
                      <span className="text-muted-foreground ml-2">
                        ({loadingProgress.file})
                      </span>
                    )}
                  </span>
                ) : (
                  'Loading Whisper model...'
                )}
              </div>
            </div>
          </Card>
        )}
        {/* Speaker models loading */}
        {identifySpeakers && diarization.isLoading && (
          <Card className="p-6 mb-6 bg-muted/50">
            <div className="flex items-center justify-center space-x-3">
              <Loader2 className="h-5 w-5 animate-spin" />
              <div className="text-sm">
                {diarization.loadingProgress ? (
                  <span>
                    {diarization.loadingProgress.status}: {Math.round(diarization.loadingProgress.progress)}%
                    {diarization.loadingProgress.file && (
                      <span className="text-muted-foreground ml-2">({diarization.loadingProgress.file})</span>
                    )}
                  </span>
                ) : (
                  'Loading speaker models...'
                )}
              </div>
            </div>
          </Card>
        )}

        {diarization.error && (
          <Card className="p-4 mb-6 bg-destructive/10 border-destructive/20">
            <p className="text-destructive text-sm">{diarization.error}</p>
          </Card>
        )}


        {/* Error Display */}
        {error && (
          <Card className="p-4 mb-6 bg-destructive/10 border-destructive/20">
            <p className="text-destructive text-sm">{error}</p>
          </Card>
        )}

        {/* Main Interface */}
        <Card className="mb-6">
          <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />
          
          <div className="p-6 space-y-6">
            {/* Tab Content */}
            {activeTab === 'url' && (
              <URLInput 
                onAudioLoad={handleAudioLoad} 
                disabled={isLoading}
                value={urlInputValue}
                onChange={setUrlInputValue}
              />
            )}
            
            {activeTab === 'file' && (
              <FileInput onFileSelect={handleFileSelect} disabled={isLoading} />
            )}
            {activeTab === 'file' && fileDetails && (
              <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Selected File:</span>
                </div>
                <div className="text-sm text-muted-foreground space-y-1">
                  <div><strong>Name:</strong> {fileDetails.name}</div>
                  <div><strong>Size:</strong> {fileDetails.size}</div>
                  {fileDetails.duration && (
                    <div><strong>Duration:</strong> {fileDetails.duration}</div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'record' && (
              <RecordInput 
                onRecordingComplete={handleRecordingComplete} 
                disabled={isLoading} 
                existingBlob={recordingBlob}
              />
            )}

            {isConverting && (
              <Card className="p-4 mb-4 flex items-center gap-3 bg-muted/50">
                <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Converting audio to WAV format...</span>
              </Card>
            )}
           
            {/* Mode: plain transcript, or transcript with speaker labels */}
            <div className="space-y-2">
              <div role="radiogroup" aria-label="Transcription mode" className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-1">
                {[
                  { speakers: false, label: 'Transcript only', icon: FileText },
                  { speakers: true, label: 'Transcript + speakers', icon: Users }
                ].map(({ speakers, label, icon: Icon }) => {
                  const selected = identifySpeakers === speakers;
                  return (
                    <Button
                      key={label}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      variant={selected ? 'default' : 'ghost'}
                      onClick={() => chooseMode(speakers)}
                      disabled={isBusy}
                      className="w-full"
                    >
                      <Icon className="h-4 w-4 mr-2" />
                      {label}
                    </Button>
                  );
                })}
              </div>
              {identifySpeakers && (
                <div className="flex items-center justify-center gap-2">
                  <label htmlFor="num-speakers" className="text-sm text-muted-foreground">Number of speakers</label>
                  <Select
                    value={String(numSpeakers)}
                    onValueChange={(v) => setNumSpeakers(Number(v))}
                    disabled={isBusy}
                  >
                    <SelectTrigger id="num-speakers" className="w-32 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Auto</SelectItem>
                      {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                        <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <p className="text-xs text-muted-foreground text-center">
                {identifySpeakers
                  ? 'Labels who is speaking, any number of people. If you know how many there are, pick it: results get more accurate. Slower than transcript only. '
                  : ''}
                {modeStatus}
              </p>
            </div>

            {/* Media Player */}
            {hasAudio && (
              <MediaPlayer
                src={audioSrc}
                audioBlob={mediaFile ?? audioBlob}
                isVideo={!!mediaFile?.type.startsWith('video/')}
              />
            )}
            {/* Transcribe Button and Settings */}
            {hasAudio && (
              <div className="flex items-center justify-center gap-4">
                <Button
                  onClick={handleTranscribe}
                  disabled={!canTranscribe}
                  size="lg"
                  className="px-8"
                >
                  {isTranscribing || diarization.isTranscribing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Transcribing...
                    </>
                  ) : identifySpeakers ? (
                    'Transcribe + Identify Speakers'
                  ) : (
                    'Transcribe Audio'
                  )}
                </Button>
                
                <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="lg" className="h-10 w-10 p-0">
                      <Settings className="h-4 w-4" />
                    </Button>
                  </DialogTrigger>

                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>Model Settings</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-6">

                      <ModelSelector
                        models={DEFAULT_MODELS}
                        selectedModel={selectedModelKey}
                        onModelChange={handleModelChange}
                        disabled={isLoading || identifySpeakers}
                      />
                      {identifySpeakers && (
                        <p className="text-xs text-muted-foreground">
                          "Transcript + speakers" uses its own models (Whisper Base timestamped + pyannote),
                          so this choice only applies to "Transcript only".
                        </p>
                      )}
                      
                      {currentModel && (
                        <div className="p-3 bg-muted/50 rounded-lg">
                          <p className="text-sm text-muted-foreground mb-1">Current Model:</p>
                          <p className="font-medium">{currentModel.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {currentModel.is_multilingual ? 'Multilingual' : 'Language: English'}
                            {device && ` · Running on ${device.toUpperCase()}`}
                          </p>
                        </div>
                      )}
                      
                      {/* Shows the status of whichever models will actually run */}
                      {identifySpeakers ? (
                        <Button
                          onClick={diarization.loadModels}
                          disabled={diarization.isLoading || diarization.isReady}
                          className="w-full"
                        >
                          {diarization.isLoading ? 'Loading speaker models...' : diarization.isReady ? 'Speaker models ready' : 'Load speaker models'}
                        </Button>
                      ) : (
                        <Button 
                          onClick={handleLoadModel} 
                          disabled={isLoading || isReady} 
                          className="w-full"
                        >
                          {isLoading ? 'Loading...' : isReady ? 'Model Ready' : 'Load Model'}
                        </Button>
                      )}
                    </div>
                  </DialogContent>

                </Dialog>
              </div>
            )}
            {/* Progress through the recording */}
            {!identifySpeakers && isTranscribing && progress && (
              <TranscriptionProgress
                title="Transcribing audio"
                done={progress.done}
                total={progress.total}
                note={device ? `Running on ${device.toUpperCase()}` : undefined}
              />
            )}
            {identifySpeakers && diarization.isTranscribing && diarization.progress && (
              diarization.progress.stage === 'transcribing' ? (
                <TranscriptionProgress
                  step="Step 1 of 2"
                  title="Transcribing audio"
                  done={diarization.progress.done}
                  total={diarization.progress.total}
                  note={`${diarization.words.length} words so far. Speaker labels come in step 2${diarization.device ? ` · ${diarization.device.toUpperCase()}` : ''}`}
                />
              ) : (
                <TranscriptionProgress
                  step="Step 2 of 2"
                  title="Identifying speakers"
                  done={diarization.progress.done}
                  total={diarization.progress.total}
                  note="Transcript is complete. Finding speech turns and matching voices across the recording (runs on the CPU)."
                  barClassName="bg-purple-500"
                />
              )
            )}
            {/* Transcription Results: speaker view when "Identify speakers" is on */}
            {identifySpeakers ? (
              <SpeakerTranscript
                lines={diarization.lines}
                liveWords={diarization.words}
                isRunning={diarization.isTranscribing}
                speakerNames={speakerNames}
                onRenameSpeaker={(label, name) => setSpeakerNames(prev => ({ ...prev, [label]: name }))}
              />
            ) : (
              <TranscriptionResults 
                result={transcriptionResult}
                isTranscribing={isTranscribing}
                segments={segments}
              />
            )}
          </div>
        </Card>


        <div className="text-center mt-12 text-sm text-muted-foreground">
          Made with 🤗 <a 
            href="https://huggingface.co/docs/transformers.js" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >Transformers.js + Whisper OpenAI</a> • <a 
            href="https://github.com/ffmpegwasm/ffmpeg.wasm" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >🎧 FFmpeg.wasm</a> • <a 
            href="https://www.youtube.com/watch?v=ozKAcqkGcjc" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >🗣️ Sample audio</a>
        </div>
      </div>
    </div>
  );
};

export default Index;