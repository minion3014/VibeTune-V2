import { useState, useRef, useEffect, useMemo, ChangeEvent } from 'react';
import { 
  Play, 
  Pause, 
  SkipBack, 
  SkipForward, 
  Music, 
  Search, 
  FolderOpen,
  ListMusic,
  X,
  RotateCcw,
  Shuffle, 
  Repeat,
  Mic2,
  Cloud,
  Loader2,
  Volume2,
  Volume1,
  VolumeX,
  AlertTriangle,
  UploadCloud
} from 'lucide-react';
import { motion, AnimatePresence, useDragControls } from 'motion/react';
import * as mm from 'music-metadata-browser';
import { parseLRC, LyricLine } from './lib/lyricParser';
import { fetchLyricsFromLRCLib } from './services/lrcLibService';
import { 
  AudioTechnicalSpecs, 
  OutputPipelineInfo, 
  extractAudioFileDetails, 
  detectAudioFormat,
  getAudioOutputPipelineInfo, 
  registerTrackedUrl, 
  revokeAllTrackedUrls,
  audioBufferToWavBlob,
  decodeAudioFileToWavBlob,
  FLACDecoderWebWorker
} from './lib/flacAudioEngine';
import { AudioTechnicalModal } from './components/AudioTechnicalModal';

interface Song {
  id: string;
  name: string;
  audioUrl: string;
  lyrics: LyricLine[];
  artist: string;
  album?: string;
  cover: string;
  lrcId?: string;
  isDrive?: boolean;
  hasLyrics?: boolean;
  isFlac: boolean;
  audioType: string;
  qualityBadge?: string;
  folder?: string;
  path?: string[];
  isLrcLibFetched?: boolean;
  metadataParsed?: boolean;
  techInfo?: AudioTechnicalSpecs;
  sourceFile?: File;
  hasDecodedFallback?: boolean;
  error?: string;
}

export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [allSongs, setAllSongs] = useState<Song[]>([]); 
  const [folders, setFolders] = useState<Map<string, Song[]>>(new Map());
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string[]>([]);
  const [currentSongIndex, setCurrentSongIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSearchingLyrics, setIsSearchingLyrics] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(true);
  const [rootFolderName, setRootFolderName] = useState<string | null>(null);
  const [playbackMode, setPlaybackMode] = useState<'normal' | 'shuffle' | 'repeat'>('normal');
  const [showLyricsView, setShowLyricsView] = useState(false);
  const [isGoogleLinked, setIsGoogleLinked] = useState(false);
  const [googleUser, setGoogleUser] = useState<{ name: string; picture: string } | null>(null);
  const [isLoadingDrive, setIsLoadingDrive] = useState(false);
  const [isLyricsLoading, setIsLyricsLoading] = useState(false);
  const [activeSource, setActiveSource] = useState<'cloud' | 'local' | null>(null);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [previousVolume, setPreviousVolume] = useState(1);

  // Audio format filtering & recognition state (FLAC vs Standard/Nhạc thường)
  const [audioFormatFilter, setAudioFormatFilter] = useState<'all' | 'flac' | 'standard'>('all');
  const [folderStatsNotice, setFolderStatsNotice] = useState<{ total: number; flac: number; standard: number; folderName: string } | null>(null);
  const [isProcessingFolder, setIsProcessingFolder] = useState(false);

  // Technical Audio Info & State
  const [showTechnicalModal, setShowTechnicalModal] = useState(false);
  const [audioErrorMessage, setAudioErrorMessage] = useState<string | null>(null);
  const [isDecodingFallback, setIsDecodingFallback] = useState(false);
  const [outputInfo, setOutputInfo] = useState<OutputPipelineInfo>(() => getAudioOutputPipelineInfo());
  const [isDragging, setIsDragging] = useState(false);
  
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileInputFolderRef = useRef<HTMLInputElement>(null);
  const fileInputFilesRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  const currentSong = songs[currentSongIndex] || null;
  const dragControls = useDragControls();

  // Refresh audio pipeline info on mount or interaction
  useEffect(() => {
    setOutputInfo(getAudioOutputPipelineInfo());
  }, []);

  // Auto-hide folder stats notice banner after 30 seconds
  useEffect(() => {
    if (folderStatsNotice) {
      const timer = setTimeout(() => {
        setFolderStatsNotice(null);
      }, 30000);
      return () => clearTimeout(timer);
    }
  }, [folderStatsNotice]);

  // Handle search interaction
  const handleSearchFocus = () => {
    setShowSearchSuggestions(true);
  };

  const handleSearchChange = (e: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setShowSearchSuggestions(true);
  };

  // Handle click outside search to close suggestions
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setShowSearchSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Process imported local audio files: Automatically recognizes FLAC vs Standard/Normal audio (MP3, WAV, M4A, etc.)
  const processImportedFiles = async (fileList: FileList | File[], isFolderSelection = false) => {
    const files = Array.from(fileList);
    if (!files || files.length === 0) return;

    // Determine root name
    const firstFileWithPath = files.find(f => (f as any).webkitRelativePath);
    const rootName = firstFileWithPath && (firstFileWithPath as any).webkitRelativePath
      ? (firstFileWithPath as any).webkitRelativePath.split('/')[0] 
      : (isFolderSelection ? 'Imported Folder' : 'Imported Tracks');
    
    setRootFolderName(rootName);
    setActiveSource('local');
    setCurrentPath([rootName]);
    setAudioErrorMessage(null);
    setIsProcessingFolder(true);

    const lrcMap = new Map<string, File>();
    const audioItems: { file: File; parentFolders: string[]; folderKey: string; immediateParent: string; baseName: string }[] = [];
    const supportedAudioExts = new Set([
      'flac', 'fla', 'mp3', 'wav', 'wave', 'm4a', 'aac', 'ogg', 'oga', 'opus', 
      'alac', 'wma', 'aif', 'aiff', 'webm', 'weba', 'm4b', 'mp4'
    ]);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const relPath = (file as any).webkitRelativePath || file.name;
      const pathParts = relPath.split('/');
      
      const parentFolders: string[] = [];
      if ((file as any).webkitRelativePath) {
        for (let j = 0; j < pathParts.length - 1; j++) {
          if (pathParts[j]) parentFolders.push(pathParts[j]);
        }
      }
      if (parentFolders.length === 0) parentFolders.push(rootName);
      
      const lastDotIndex = file.name.lastIndexOf('.');
      const ext = lastDotIndex !== -1 ? file.name.substring(lastDotIndex + 1).toLowerCase() : '';
      const baseName = lastDotIndex !== -1 ? file.name.substring(0, lastDotIndex).toLowerCase() : file.name.toLowerCase();

      const immediateParent = parentFolders[parentFolders.length - 1] || rootName;
      const folderKey = parentFolders.join('/');

      if (ext === 'txt' || ext === 'lrc') {
        lrcMap.set(`${folderKey}:${baseName}`, file);
      } else if (
        supportedAudioExts.has(ext) || 
        file.type.startsWith('audio/') || 
        file.name.toLowerCase().endsWith('.flac') ||
        file.name.toLowerCase().endsWith('.m4a') ||
        (file.type === '' && file.size > 100000)
      ) {
        audioItems.push({
          file,
          parentFolders,
          folderKey,
          immediateParent,
          baseName
        });
      }
    }

    if (audioItems.length === 0) {
      setIsProcessingFolder(false);
      alert("Không tìm thấy file nhạc hợp lệ (.flac, .mp3, .wav, .m4a...) trong thư mục đã chọn.");
      return;
    }

    let flacCount = 0;
    let standardCount = 0;
    const folderMap = new Map<string, Song[]>();
    const allLoadedSongs: Song[] = [];

    // Process audio items with concurrent batches for high responsiveness
    const batchSize = 6;
    for (let i = 0; i < audioItems.length; i += batchSize) {
      const batch = audioItems.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(async (item) => {
        const { file, parentFolders, folderKey, immediateParent, baseName } = item;

        // 1. Accurately detect audio format (FLAC vs regular audio vs ALAC)
        const detection = await detectAudioFormat(file, file.name);
        const isFlac = detection.isFlac;

        // 2. Check for matching lyrics
        let lyrics: LyricLine[] = [];
        const matchedLrc = lrcMap.get(`${folderKey}:${baseName}`);
        if (matchedLrc) {
          try {
            const lrcText = await matchedLrc.text();
            lyrics = parseLRC(lrcText);
          } catch (e) {
            console.error("Error parsing lyrics for:", file.name, e);
          }
        }

        // 3. Extract metadata, embedded cover art, and technical specs
        let details: any = null;
        try {
          details = await extractAudioFileDetails(file);
        } catch (err) {
          console.warn("Metadata extraction fallback for:", file.name, err);
        }

        const songName = details?.title || (file.name.lastIndexOf('.') !== -1 ? file.name.substring(0, file.name.lastIndexOf('.')) : file.name);
        const artist = details?.artist || "Unknown Artist";
        const album = details?.album;
        const cover = details?.coverUrl || `https://picsum.photos/seed/${encodeURIComponent(file.name)}/400/400`;

        // 4. Pass the native File object directly to URL.createObjectURL.
        // This is CRITICAL for M4A, AAC, and MP4 containers: Chromium requires direct
        // native File handles to perform byte-range seeking on 'moov' atoms.
        // Slicing into a generic Blob strips the filename extension and causes Chrome to reject playback.
        const audioUrl = registerTrackedUrl(URL.createObjectURL(file));

        const isAlac = details?.specs?.format === 'ALAC' || detection.format === 'ALAC';
        const audioType = isAlac ? 'ALAC' : detection.format;
        const bits = details?.specs?.bitsPerSample || detection.streamInfo?.bitsPerSample;
        const qualityBadge = isFlac 
          ? (bits === 24 ? 'FLAC 24-bit' : 'FLAC Lossless') 
          : (isAlac 
              ? (bits === 24 ? 'ALAC 24-bit' : 'ALAC Lossless')
              : (audioType === 'WAV' ? 'WAV Lossless' : (audioType === 'AIFF' ? 'AIFF Lossless' : audioType)));

        const song: Song = {
          id: `local-${file.name}-${parentFolders.join('-')}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          name: songName,
          artist,
          album,
          audioUrl,
          lyrics,
          cover,
          isDrive: false,
          isFlac,
          audioType,
          qualityBadge,
          hasLyrics: lyrics.length > 0,
          folder: immediateParent,
          path: parentFolders,
          metadataParsed: true,
          techInfo: details?.specs,
          sourceFile: file
        };

        return { song, path: parentFolders, folderKey };
      }));

      for (const res of batchResults) {
        if (res.song.isFlac) {
          flacCount++;
        } else {
          standardCount++;
        }
        allLoadedSongs.push(res.song);

        // Ensure all parent folders exist
        let currentPathAcc = "";
        res.path.forEach((folderName, idx) => {
          currentPathAcc = idx === 0 ? folderName : `${currentPathAcc}/${folderName}`;
          if (!folderMap.has(currentPathAcc)) {
            folderMap.set(currentPathAcc, []);
          }
        });

        const fSongs = folderMap.get(res.folderKey) || [];
        folderMap.set(res.folderKey, [...fSongs, res.song]);
      }
    }

    setFolderStatsNotice({ total: allLoadedSongs.length, flac: flacCount, standard: standardCount, folderName: rootName });
    setIsProcessingFolder(false);

    // Clear previous local songs and folders
    setAllSongs(prev => {
      const filtered = prev.filter(s => s.isDrive);
      return [...filtered, ...allLoadedSongs];
    });
    
    setSongs([]);
    setCurrentPath([]); // Start at root overview
    setCurrentFolder(null);
    setAudioFormatFilter('all');
    
    setFolders(prev => {
      const next = new Map();
      // Keep cloud folders
      prev.forEach((val, key) => {
        if (val.some(s => s.isDrive)) {
          next.set(key, val);
        }
      });
      // Add new local folders
      folderMap.forEach((val, key) => {
        next.set(key, val);
      });
      // Add global All Local Songs virtual folder
      next.set("All Local Songs", allLoadedSongs);
      return next;
    });

    if (allLoadedSongs.length > 0) {
      setCurrentSongIndex(0);
      setIsPlaying(false);
    }
    
    if (fileInputFolderRef.current) fileInputFolderRef.current.value = '';
    if (fileInputFilesRef.current) fileInputFilesRef.current.value = '';
    setShowSearchSuggestions(false);
  };

  const handleFolderChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processImportedFiles(e.target.files, true);
    }
  };

  const handleFilesChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processImportedFiles(e.target.files, false);
    }
  };

  const triggerFolderSelect = () => {
    fileInputFolderRef.current?.click();
  };

  const triggerFilesSelect = () => {
    fileInputFilesRef.current?.click();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processImportedFiles(e.dataTransfer.files, false);
    }
  };

  const triggerFileSelect = () => {
    triggerFilesSelect();
  };

  const selectFolder = (folderKey: string) => {
    setAudioFormatFilter('all');
    let folderSongs: Song[] = [];
    
    if (activeSource === 'local') {
      if (folderKey === "All Local Songs") {
        folderSongs = allSongs.filter(s => !s.isDrive);
        setCurrentPath([]);
        setCurrentFolder("All Songs");
      } else if (folderKey.endsWith(' (All Songs)')) {
        const actualPath = folderKey.replace(' (All Songs)', '');
        folderSongs = allSongs.filter(s => !s.isDrive && (s.path?.join('/') === actualPath || s.path?.join('/').startsWith(actualPath + '/')));
        setCurrentPath(actualPath.split('/'));
        setCurrentFolder(actualPath.split('/').pop() + " (All Songs)");
      } else {
        folderSongs = folders.get(folderKey) || [];
        const pathSegments = folderKey.split('/');
        setCurrentPath(pathSegments);
        setCurrentFolder(pathSegments[pathSegments.length - 1]);
      }
    } else {
      if (folderKey === "All Drive Songs") {
        folderSongs = allSongs.filter(s => s.isDrive);
        setCurrentFolder("All Songs");
      } else {
        folderSongs = folders.get(folderKey) || [];
        setCurrentFolder(folderKey.split('/').pop() || folderKey);
      }
    }

    setSongs(folderSongs);
    setSearchQuery('');
    setShowSearchSuggestions(false);
  };

  const switchToCloudSource = () => {
    if (isGoogleLinked) {
      setActiveSource('cloud');
      setCurrentFolder(null);
      setCurrentPath([]);
      // Update songs list to show nothing until a folder is selected
      setSongs([]);
      fetchGoogleSongs(true); // Refresh on switch with manual flag
    } else {
      handleGoogleConnect();
    }
  };

  const switchToLocalSource = () => {
    if (activeSource === 'local' || !rootFolderName) {
      triggerFileSelect();
    } else {
      setActiveSource('local');
      setCurrentFolder(null);
      setCurrentPath(rootFolderName ? [rootFolderName] : []);
      // Update songs list to show nothing until a folder is selected
      setSongs([]);
    }
  };

  const visibleFolders = useMemo(() => {
    const folderKeys = Array.from(folders.keys());
    
    if (activeSource === 'cloud') {
      const results = folderKeys.filter(name => {
        const folderSongs = folders.get(name) || [];
        return folderSongs.some(s => s.isDrive) && !currentFolder;
      });
      if (!currentFolder) results.unshift("All Drive Songs");
      return results.sort();
    }
    
    if (activeSource === 'local') {
      const currentPrefix = currentPath.join('/');
      let results: string[] = [];

      if (currentPrefix === "") {
        // At root level
        results.push("All Local Songs");
        
        const rootSegments = new Set<string>();
        folderKeys.forEach(name => {
          if (name === "All Local Songs") return;
          const segments = name.split('/');
          if (segments.length >= 1) rootSegments.add(segments[0]);
        });

        rootSegments.forEach(root => {
          // Flatten: show direct children immediately
          folderKeys.forEach(name => {
            if (name.startsWith(root + '/') && name.split('/').length === 2) {
              results.push(name);
            }
          });
        });
      } else {
        // Inside a folder
        const directChildren = folderKeys.filter(name => {
          if (name === "All Local Songs" || name === currentPrefix) return false;
          const prefixWithSlash = currentPrefix + '/';
          if (name.startsWith(prefixWithSlash)) {
            const remaining = name.substring(prefixWithSlash.length);
            return !remaining.includes('/');
          }
          return false;
        });
        
        results = [...directChildren];
      }
      
      const unique = Array.from(new Set(results));
      return unique.sort((a, b) => {
        const isVirtualA = a.includes('All Songs') || a === "All Local Songs";
        const isVirtualB = b.includes('All Songs') || b === "All Local Songs";
        if (isVirtualA && !isVirtualB) return -1;
        if (!isVirtualA && isVirtualB) return 1;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
      });
    }
    
    return [];
  }, [folders, activeSource, currentPath, currentFolder]);

  const handleFetchLyrics = async (song: Song, force = false) => {
    if (isSearchingLyrics) return;
    
    // Prioritize existing lyrics unless forced (retry)
    if (!force && song.lyrics.length > 0) return;
    
    // Ensure we have metadata before searching
    let targetSong = song;
    if (song.isDrive && !song.metadataParsed) {
       const enriched = await enrichDriveSongMetadata(song);
       if (enriched) targetSong = enriched;
       // If enrichment loaded lyrics from Drive, and we are not forcing, stop here
       if (!force && targetSong.lyrics.length > 0) return;
    }

    setIsSearchingLyrics(true);
    try {
      const lrc = await fetchLyricsFromLRCLib(targetSong.name, targetSong.artist);
      if (lrc) {
        const parsed = parseLRC(lrc);
        const updatedSong = { 
          ...targetSong, 
          lyrics: parsed, 
          isLrcLibFetched: true, 
          hasLyrics: true 
        };
        
        setAllSongs(prev => prev.map(s => s.id === targetSong.id ? updatedSong : s));
        setSongs(prev => prev.map(s => s.id === targetSong.id ? updatedSong : s));
      } else {
        const updatedSong = { ...targetSong, isLrcLibFetched: true, hasLyrics: false, lyrics: [] };
        setAllSongs(prev => prev.map(s => s.id === targetSong.id ? updatedSong : s));
        setSongs(prev => prev.map(s => s.id === targetSong.id ? updatedSong : s));
      }
    } catch (e) {
      console.error("Error in handleFetchLyrics:", e);
    } finally {
      setIsSearchingLyrics(false);
    }
  };

  const enrichDriveSongMetadata = async (song: Song): Promise<Song | null> => {
    if (!song.isDrive || (song.metadataParsed && song.lyrics.length > 0)) return null;
    
    let updatedLyrics = song.lyrics;
    let updatedName = song.name;
    let updatedArtist = song.artist;
    let metadataParsedSuccessfully = song.metadataParsed;

    try {
      // 1. Fetch lyrics content if lrcId is present and we don't have lyrics yet
      if (song.lrcId && song.lyrics.length === 0) {
        try {
          const lrcResp = await fetch(`/api/drive/lyrics/${song.lrcId}`);
          if (lrcResp.ok) {
            const lrcText = await lrcResp.text();
            updatedLyrics = parseLRC(lrcText);
          }
        } catch (lrcError) {
          console.error("Error fetching lyrics from Drive:", lrcError);
        }
      }

      // 2. Parse metadata if not yet parsed
      let updatedCover = song.cover;
      let updatedAlbum = song.album;
      let techInfo = song.techInfo;

      if (!song.metadataParsed) {
        const response = await fetch(song.audioUrl, {
          // Range to capture FLAC STREAMINFO and PICTURE metadata blocks
          headers: { Range: 'bytes=0-1572864' }
        });
        
        if (response.ok || response.status === 206) {
          const blob = await response.blob();
          const metadata = await mm.parseBlob(blob);
          
          if (metadata.common.title) {
            updatedName = metadata.common.title.trim();
          }
          
          const potentialArtist = 
            metadata.common.artist || 
            (metadata.common.artists && metadata.common.artists.length > 0 ? metadata.common.artists.join(', ') : null) ||
            metadata.common.albumartist ||
            metadata.common.composer;
            
          if (potentialArtist) {
            updatedArtist = Array.isArray(potentialArtist) ? (potentialArtist as any[]).join(', ') : String(potentialArtist).trim();
          }

          if (metadata.common.album) {
            updatedAlbum = metadata.common.album.trim();
          }

          if (metadata.common.picture && metadata.common.picture.length > 0) {
            const pic = metadata.common.picture[0];
            try {
              const picBlob = new Blob([pic.data], { type: pic.format || 'image/jpeg' });
              updatedCover = registerTrackedUrl(URL.createObjectURL(picBlob));
            } catch (err) {
              // Ignore image extraction error
            }
          }

          const isFlac = song.name.toLowerCase().endsWith('.flac') || metadata.format.container === 'FLAC';
          const audioType = isFlac ? 'FLAC' : (metadata.format.container || 'MP3').toUpperCase();
          const qualityBadge = isFlac 
            ? ((metadata.format.bitsPerSample === 24) ? 'FLAC 24-bit' : 'FLAC Lossless') 
            : audioType;

          techInfo = {
            format: isFlac ? 'FLAC' : (metadata.format.container || 'AUDIO').toUpperCase(),
            container: metadata.format.container,
            codec: isFlac ? 'FLAC (Free Lossless Audio Codec)' : metadata.format.codec,
            lossless: isFlac || metadata.format.lossless === true,
            sampleRate: metadata.format.sampleRate || 44100,
            bitsPerSample: metadata.format.bitsPerSample || (isFlac ? 16 : 16),
            channels: metadata.format.numberOfChannels || 2,
            bitrate: metadata.format.bitrate,
            duration: metadata.format.duration,
            album: updatedAlbum,
            decoderEngine: isFlac ? 'Chromium Native Streaming (Drive Stream)' : 'Native Browser Media Engine',
            pcmFormat: `${metadata.format.bitsPerSample || 16}-bit / 32-bit Float Linear PCM`
          };

          metadataParsedSuccessfully = true;
        }
      }
      
      const updatedSong = { 
        ...song, 
        name: updatedName, 
        artist: updatedArtist, 
        album: updatedAlbum,
        cover: updatedCover,
        lyrics: updatedLyrics,
        isFlac: song.isFlac ?? (song.name.toLowerCase().endsWith('.flac') || techInfo?.format === 'FLAC'),
        audioType: techInfo?.format || (song.name.toLowerCase().endsWith('.flac') ? 'FLAC' : 'MP3'),
        qualityBadge: (song.name.toLowerCase().endsWith('.flac') || techInfo?.format === 'FLAC') ? 'FLAC Lossless' : 'MP3',
        metadataParsed: metadataParsedSuccessfully,
        techInfo: techInfo || song.techInfo,
        hasLyrics: updatedLyrics.length > 0 || song.hasLyrics
      };
      
      setAllSongs(prev => prev.map(s => s.id === song.id ? updatedSong : s));
      setSongs(prev => prev.map(s => s.id === song.id ? updatedSong : s));
      
      return updatedSong;
    } catch (e) {
      console.error("Error enriching metadata/lyrics for Drive song:", e);
      // Mark as parsed to avoid infinite loop
      const updatedSong = { ...song, metadataParsed: true };
      setAllSongs(prev => prev.map(s => s.id === song.id ? updatedSong : s));
      setSongs(prev => prev.map(s => s.id === song.id ? updatedSong : s));
      return updatedSong;
    }
  };

  useEffect(() => {
    if (currentSong && currentSong.isDrive && !currentSong.metadataParsed) {
      enrichDriveSongMetadata(currentSong);
    }
    
    if (currentSong && currentSong.lyrics.length === 0 && !currentSong.isLrcLibFetched) {
      handleFetchLyrics(currentSong);
    }
  }, [currentSongIndex, currentSong?.id]);

  const handleGoogleConnect = async () => {
    try {
      const resp = await fetch('/api/auth/google/url');
      const { url } = await resp.json();
      window.open(url, 'google_auth', 'width=500,height=600');
    } catch (e) {
      // Auth URL failed
    }
  };

  const fetchGoogleSongs = async (isManual = false) => {
    setIsLoadingDrive(true);
    try {
      const resp = await fetch('/api/drive/songs');
      
      if (!resp.ok) {
        if (resp.status === 401) {
          setIsGoogleLinked(false);
          setGoogleUser(null);
          return;
        }
        throw new Error(`Server returned ${resp.status}`);
      }

      const data = await resp.json();
      
      if (!data || typeof data !== 'object') {
         return;
      }

      const driveSongs = data.songs || [];
      const driveUser = data.user || null;
      
      setGoogleUser(driveUser);
      setIsGoogleLinked(true);
      
      if (driveSongs.length > 0) {
        if (isManual) {
          setActiveSource('cloud');
          setCurrentPath([]); // Start at root for cloud
          setCurrentFolder(null);
        }
      }
      
      const songsWithDriveFlag = driveSongs.map((s: any) => {
        const isFlac = s.name.toLowerCase().endsWith('.flac');
        return { 
          ...s, 
          isDrive: true, 
          isFlac,
          audioType: isFlac ? 'FLAC' : 'MP3',
          qualityBadge: isFlac ? 'FLAC Lossless' : 'MP3',
          lyrics: s.lyrics || [] 
        };
      });
      
      const newFolders = new Map(folders);
      
      // Helper for unique song merging
      const mergeSongs = (existing: Song[], incoming: Song[]) => {
        const ids = new Set(existing.map(s => s.id));
        return [...existing, ...incoming.filter(s => !ids.has(s.id))];
      };

      // Group by folder from Drive (handling nested folders)
      songsWithDriveFlag.forEach((song: any) => {
        const pathParts = song.folder.split('/');
        const foldersToAddTo = (pathParts.length === 1 && pathParts[0] === "Root")
          ? ["Google Drive"]
          : pathParts;
        
        foldersToAddTo.forEach((folderName: string) => {
          if (!folderName) return;
          const folderSongs = newFolders.get(folderName) || [];
          newFolders.set(folderName, mergeSongs(folderSongs, [song]));
        });
      });

      // Also keep a "All Drive Songs" folder
      newFolders.set("All Drive Songs", songsWithDriveFlag);
      
      setAllSongs(prev => mergeSongs(prev, songsWithDriveFlag));
      
      // Update current song view if we are on cloud or just loaded it
      if (activeSource === 'cloud' || (activeSource === 'local' && driveSongs.length > 0)) {
        // Prepare songs but stay on current view source
        setSongs(prev => {
          if (activeSource === 'cloud' && currentFolder) {
             return mergeSongs(prev, songsWithDriveFlag);
          }
          return prev;
        });
      }
      
      setFolders(newFolders);
    } catch (e) {
      console.error("Failed to fetch Google Drive songs:", e);
    } finally {
      setIsLoadingDrive(false);
    }
  };

  useEffect(() => {
    // Initial silent check on mount
    fetchGoogleSongs();
  }, []);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'GOOGLE_AUTH_SUCCESS') {
        fetchGoogleSongs();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []); // Only register once

  // Handle Google Lyrics fetching
  useEffect(() => {
    if (currentSong?.isDrive && currentSong.lrcId && (!currentSong.lyrics || currentSong.lyrics.length === 0)) {
      const songIdAtFetch = currentSong.id;
      setIsLyricsLoading(true);
      
      fetch(`/api/drive/lyrics/${currentSong.lrcId}`)
        .then(r => {
          if (!r.ok) throw new Error(`Fetch failed: ${r.statusText}`);
          return r.text();
        })
        .then(text => {
          if (!text || text.trim() === "") return;
          
          const parsed = parseLRC(text);
          if (parsed.length === 0) return;

          const updateSong = (s: Song) => s.id === songIdAtFetch ? { ...s, lyrics: parsed, hasLyrics: true } : s;
          
          setSongs(prev => prev.map(updateSong));
          setAllSongs(prev => prev.map(updateSong));
          setFolders(prev => {
            const next = new Map(prev);
            for (const [key, val] of next.entries()) {
              next.set(key, val.map(updateSong));
            }
            return next;
          });
        })
        .catch(err => {
          // Error handling
        })
        .finally(() => {
          setIsLyricsLoading(false);
        });
    }
  }, [currentSong?.id, currentSong?.lrcId]);

  const resetFilter = () => {
    setCurrentPath([]);
    setCurrentFolder(null);
    setSearchQuery('');
    setAudioFormatFilter('all');
    setSongs([]);
  };

  const goBack = () => {
    if (activeSource === 'local' && currentPath.length > 0) {
      if (currentPath.length === 1) {
        resetFilter();
      } else {
        const newPath = currentPath.slice(0, -1);
        const folderKey = newPath.join('/');
        const folderSongs = folders.get(folderKey) || [];
        setSongs(folderSongs);
        setCurrentPath(newPath);
        setCurrentFolder(newPath[newPath.length - 1]);
      }
    } else {
      resetFilter();
    }
  };

  const songSuggestions = useMemo(() => {
    if (!searchQuery) return [];
    const lowerQuery = searchQuery.toLowerCase();
    return allSongs.filter(s => {
      // Filter by active source
      const matchesSource = activeSource === 'cloud' ? s.isDrive : !s.isDrive;
      if (!matchesSource) return false;
      
      return s.name.toLowerCase().includes(lowerQuery) || 
             s.artist.toLowerCase().includes(lowerQuery);
    }).slice(0, 10);
  }, [searchQuery, allSongs, activeSource]);

  const playAudio = async () => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    try {
      await audio.play();
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (
        e.name !== 'AbortError' && 
        e.name !== 'NotAllowedError' &&
        !msg.includes('interrupted') &&
        !msg.includes('no supported source') &&
        !msg.includes('Failed to load')
      ) {
        console.warn("Audio play notice:", msg);
      }
    }
  };

  // Volume sync
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  const toggleMute = () => {
    if (isMuted) {
      setVolume(previousVolume);
      setIsMuted(false);
    } else {
      setPreviousVolume(volume);
      setIsMuted(true);
    }
  };

  const handleVolumeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (newVolume > 0) setIsMuted(false);
  };

  // Playback logic
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      playAudio();
    } else {
      audio.pause();
    }
  }, [isPlaying, currentSongIndex]);

  const togglePlay = () => setIsPlaying(!isPlaying);

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleAudioError = async () => {
    const song = currentSong;
    if (!song) return;

    // Verify if media element actually has an error
    const elementError = audioRef.current?.error;
    
    // Ignore aborted loads (code 1 = MEDIA_ERR_ABORTED), missing audio URLs, or transient states
    if (elementError?.code === 1 || !audioRef.current?.src || !song.audioUrl) {
      return;
    }

    if (!elementError && !audioRef.current?.src) {
      return;
    }

    console.warn("Audio element playback error for:", song.name, song.audioType, elementError);

    // Prevent infinite retry loop if this song already failed fallback decoding
    if (song.hasDecodedFallback) {
      setAudioErrorMessage(`Không thể phát "${song.name}": Định dạng không tương thích hoặc file bị hỏng.`);
      return;
    }

    setAudioErrorMessage(`Đang kích hoạt bộ giải mã tương thích cho "${song.name}" (${song.audioType || 'Audio'})...`);
    setIsDecodingFallback(true);

    try {
      let buffer: ArrayBuffer | null = null;
      if (song.sourceFile) {
        buffer = await song.sourceFile.arrayBuffer();
      } else if (song.audioUrl) {
        try {
          const resp = await fetch(song.audioUrl);
          if (resp.ok) {
            buffer = await resp.arrayBuffer();
          }
        } catch (fetchErr) {
          console.warn("Fetch audioUrl for fallback decoding failed:", fetchErr);
        }
      }

      if (buffer && buffer.byteLength > 0) {
        const decoded = await decodeAudioFileToWavBlob(buffer, song.audioType, song.name);
        if (decoded && decoded.wavBlob) {
          const fallbackUrl = registerTrackedUrl(URL.createObjectURL(decoded.wavBlob));
          song.audioUrl = fallbackUrl;
          song.hasDecodedFallback = true;
          if (song.techInfo) {
            song.techInfo.decoderEngine = decoded.decoderEngine;
            if (decoded.sampleRate) song.techInfo.sampleRate = decoded.sampleRate;
          }

          if (audioRef.current) {
            audioRef.current.src = fallbackUrl;
            audioRef.current.load();
            try {
              await audioRef.current.play();
              setAudioErrorMessage(null);
              setIsPlaying(true);
            } catch (playErr: any) {
              const pMsg = playErr?.message || String(playErr);
              if (
                playErr.name === 'AbortError' || 
                playErr.name === 'NotAllowedError' ||
                pMsg.includes('interrupted') ||
                pMsg.includes('no supported source') ||
                pMsg.includes('Failed to load')
              ) {
                console.log("Fallback play interrupted by user or new track load");
                setAudioErrorMessage(null);
                setIsDecodingFallback(false);
                return;
              }
              throw playErr;
            }
          }
          setIsDecodingFallback(false);
          return;
        }
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (
        err?.name === 'AbortError' || 
        err?.name === 'NotAllowedError' || 
        errMsg.includes('interrupted') || 
        errMsg.includes('no supported source') || 
        errMsg.includes('Failed to load') ||
        errMsg.includes('aborted')
      ) {
        setIsDecodingFallback(false);
        return;
      }
      console.warn("Audio fallback decoding notice:", errMsg);
    } finally {
      setIsDecodingFallback(false);
    }

    setAudioErrorMessage(`Không thể phát "${song.name}". Vui lòng kiểm tra lại file.`);
  };

  const handleSeek = (e: ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  };

  const handleReplay = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      setCurrentTime(0);
      setIsPlaying(true);
      playAudio();
    }
  };

  const nextSong = () => {
    if (songs.length === 0) return;
    
    if (playbackMode === 'repeat') {
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
        playAudio();
      }
      setIsPlaying(true);
      return;
    }

    if (playbackMode === 'shuffle') {
      let nextIndex = Math.floor(Math.random() * songs.length);
      if (songs.length > 1 && nextIndex === currentSongIndex) {
        nextIndex = (nextIndex + 1) % songs.length;
      }
      setCurrentSongIndex(nextIndex);
    } else {
      setCurrentSongIndex((prev) => (prev + 1) % songs.length);
    }
    setIsPlaying(true);
  };

  const prevSong = () => {
    if (songs.length === 0) return;
    setCurrentSongIndex((prev) => (prev - 1 + songs.length) % songs.length);
    setIsPlaying(true);
  };

  const currentLyricIndex = useMemo(() => {
    if (!currentSong || currentSong.lyrics.length === 0 || currentTime <= 0) return -1;
    return currentSong.lyrics.findIndex((line, i) => {
      const nextLine = currentSong.lyrics[i + 1];
      return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
    });
  }, [currentSong, currentTime]);

  const filteredSongsDisplay = useMemo(() => {
    let songsToFilter = (!currentFolder && searchQuery !== "") 
      ? allSongs.filter(s => activeSource === 'cloud' ? s.isDrive : !s.isDrive)
      : songs;

    if (audioFormatFilter === 'flac') {
      songsToFilter = songsToFilter.filter(s => s.isFlac);
    } else if (audioFormatFilter === 'standard') {
      songsToFilter = songsToFilter.filter(s => !s.isFlac);
    }

    return songsToFilter.filter(s => {
      const matchesSearch = s.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                           s.artist.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSearch;
    });
  }, [songs, allSongs, searchQuery, currentFolder, activeSource, audioFormatFilter]);

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const renderFormatFilter = () => {
    const list = (!currentFolder && searchQuery !== "") 
      ? allSongs.filter(s => activeSource === 'cloud' ? s.isDrive : !s.isDrive)
      : songs;
    if (list.length === 0) return null;

    const flacCount = list.filter(s => s.isFlac).length;
    const standardCount = list.filter(s => !s.isFlac).length;

    return (
      <div className="flex items-center gap-1.5 px-1 py-1 mb-3 overflow-x-auto no-scrollbar">
        <button
          onClick={() => setAudioFormatFilter('all')}
          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${
            audioFormatFilter === 'all'
              ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
              : 'bg-white/5 text-gray-400 hover:text-white hover:bg-white/10'
          }`}
        >
          Tất cả ({list.length})
        </button>
        <button
          onClick={() => setAudioFormatFilter('flac')}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${
            audioFormatFilter === 'flac'
              ? 'bg-cyan-500 text-black shadow-md shadow-cyan-500/30'
              : 'bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 border border-cyan-500/20'
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          FLAC ({flacCount})
        </button>
        <button
          onClick={() => setAudioFormatFilter('standard')}
          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${
            audioFormatFilter === 'standard'
              ? 'bg-white/20 text-white shadow-md'
              : 'bg-white/5 text-gray-400 hover:text-white hover:bg-white/10'
          }`}
        >
          Nhạc thường ({standardCount})
        </button>
      </div>
    );
  };

  const renderFolderNotification = () => {
    if (isProcessingFolder) {
      return (
        <div className="mx-2 mb-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl flex items-center gap-3">
          <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
          <span className="text-xs text-blue-300 font-medium">Đang nhận diện các định dạng: FLAC, M4A, MP3, WAV...</span>
        </div>
      );
    }
    if (folderStatsNotice) {
      return (
        <div className="mx-2 mb-3 p-2.5 bg-gradient-to-r from-blue-500/10 via-cyan-500/10 to-transparent border border-cyan-500/20 rounded-xl flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 overflow-hidden">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse flex-shrink-0" />
            <span className="text-gray-300 truncate">
              Đã tải: <strong className="text-cyan-400">{folderStatsNotice.flac} FLAC</strong>, <strong className="text-gray-200">{folderStatsNotice.standard} định dạng khác (M4A, MP3, WAV...)</strong>
            </span>
          </div>
          <button 
            onClick={() => setFolderStatsNotice(null)} 
            className="text-gray-500 hover:text-white p-1 ml-2 flex-shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      );
    }
    return null;
  };

  const renderSongList = () => {
    const rawList = (!currentFolder && searchQuery !== "") 
      ? allSongs.filter(s => activeSource === 'cloud' ? s.isDrive : !s.isDrive)
      : songs;

    if (!currentFolder && activeSource && searchQuery === "") return null;
    if (rawList.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-gray-500 text-center p-6 bg-white/5 border border-dashed border-white/10 rounded-2xl mx-1">
          <Music className="w-12 h-12 mb-4 opacity-20" />
          <p className="text-sm font-bold text-gray-300">Chưa có bài hát trong thư viện</p>
          
          <div className="mt-6 space-y-3 w-full max-w-[220px]">
            <button 
              onClick={triggerFolderSelect}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl transition-all text-xs font-black uppercase tracking-wider shadow-lg shadow-blue-500/20"
            >
              <FolderOpen className="w-4 h-4" />
              Mở Thư Mục Nhạc
            </button>
            <button 
              onClick={() => fetchGoogleSongs(true)}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-xl transition-all text-xs font-black uppercase tracking-wider"
            >
              <Cloud className="w-4 h-4" />
              Google Drive
            </button>
          </div>
          <p className="mt-4 text-[10px] opacity-40 leading-relaxed italic">
            Tự động nhận diện FLAC Lossless & Nhạc thường (MP3, WAV, M4A...)
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-1">
        {renderFormatFilter()}
        {filteredSongsDisplay.length === 0 ? (
          <div className="py-12 text-center text-gray-400 bg-white/5 rounded-2xl p-6 border border-white/5 my-2 flex flex-col items-center justify-center">
            <ListMusic className="w-8 h-8 mb-2 opacity-30 text-cyan-400" />
            <p className="text-xs font-medium text-gray-300">
              Không tìm thấy bài hát định dạng <strong className="text-cyan-400">{audioFormatFilter === 'flac' ? 'FLAC' : 'Nhạc thường'}</strong> trong mục này
            </p>
            <button
              onClick={() => setAudioFormatFilter('all')}
              className="mt-3 px-4 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-lg text-xs font-bold transition-all border border-blue-500/30 hover:scale-105"
            >
              Xem tất cả bài hát ({rawList.length})
            </button>
          </div>
        ) : (
          filteredSongsDisplay.map((song) => (
          <div
            key={song.id}
            role="button"
            tabIndex={0}
            data-active-song={currentSong?.id === song.id}
            onClick={() => {
              const index = songs.indexOf(song);
              if (index === currentSongIndex) {
                handleReplay();
              } else {
                setCurrentSongIndex(index);
                setIsPlaying(true);
              }
              if (window.innerWidth < 768) setIsLibraryOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const index = songs.indexOf(song);
                if (index === currentSongIndex) {
                  handleReplay();
                } else {
                  setCurrentSongIndex(index);
                  setIsPlaying(true);
                }
                if (window.innerWidth < 768) setIsLibraryOpen(false);
              }
            }}
            className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all group border border-transparent cursor-pointer ${
              currentSong?.id === song.id 
                ? 'bg-blue-500/10 text-white border-blue-500/30' 
                : 'hover:bg-white/5 text-gray-400 hover:text-white'
            }`}
          >
            <div className="relative flex-shrink-0">
              <img 
                src={song.cover} 
                alt={song.name} 
                className={`w-12 h-12 rounded-lg object-cover shadow-lg transition-transform ${currentSong?.id === song.id ? 'scale-90' : 'group-hover:scale-105'}`}
                referrerPolicy="no-referrer"
              />
              {currentSong?.id === song.id && isPlaying && (
                <div className="absolute inset-0 bg-black/40 rounded-lg flex items-center justify-center">
                  <div className="flex gap-0.5 items-end h-3">
                    <motion.div animate={{ height: [4, 12, 4] }} transition={{ repeat: Infinity, duration: 0.6 }} className="w-0.5 bg-white" />
                    <motion.div animate={{ height: [8, 4, 8] }} transition={{ repeat: Infinity, duration: 0.8 }} className="w-0.5 bg-white" />
                    <motion.div animate={{ height: [4, 10, 4] }} transition={{ repeat: Infinity, duration: 0.7 }} className="w-0.5 bg-white" />
                  </div>
                </div>
              )}
            </div>
            <div className="flex-1 text-left overflow-hidden">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className={`font-bold truncate text-sm ${currentSong?.id === song.id ? 'text-blue-400' : 'text-gray-200'}`}>
                  {song.name}
                </p>
                {song.isFlac ? (
                  <button
                    type="button"
                    title="Bấm để xem thông số kỹ thuật âm thanh"
                    onClick={(e) => {
                      e.stopPropagation();
                      const index = songs.indexOf(song);
                      if (index !== -1) {
                        setCurrentSongIndex(index);
                      }
                      setShowTechnicalModal(true);
                    }}
                    className="flex-shrink-0 px-1.5 py-0.5 bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-400 text-[8px] font-black rounded border border-cyan-500/30 uppercase tracking-wider shadow-[0_0_8px_rgba(6,182,212,0.15)] transition-all transform hover:scale-105 cursor-pointer"
                  >
                    {song.qualityBadge || 'FLAC'}
                  </button>
                ) : (
                  <button
                    type="button"
                    title="Bấm để xem thông số kỹ thuật âm thanh"
                    onClick={(e) => {
                      e.stopPropagation();
                      const index = songs.indexOf(song);
                      if (index !== -1) {
                        setCurrentSongIndex(index);
                      }
                      setShowTechnicalModal(true);
                    }}
                    className="flex-shrink-0 px-1.5 py-0.5 bg-white/5 hover:bg-white/15 text-gray-400 hover:text-white text-[8px] font-bold rounded border border-white/10 uppercase tracking-wider transition-all transform hover:scale-105 cursor-pointer"
                  >
                    {song.audioType || 'MP3'}
                  </button>
                )}
                {song.hasLyrics && (
                  <span className="flex-shrink-0 px-1 py-0.5 bg-blue-500/20 text-blue-400 text-[8px] font-black rounded border border-blue-500/30 uppercase tracking-tighter">
                    LRC
                  </span>
                )}
              </div>
              <p className="text-[11px] opacity-50 truncate font-medium">
                {song.artist} {song.album ? `• ${song.album}` : ''}
              </p>
            </div>
          </div>
        )))}
      </div>
    );
  };

  // Auto-scroll to active song in the menu/sidebar
  useEffect(() => {
    if (isLibraryOpen && currentSong) {
      // Small timeout to allow the folder switch or library opening animations to complete
      const timer = setTimeout(() => {
        const activeElements = document.querySelectorAll(`[data-active-song="true"]`);
        activeElements.forEach(el => {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [currentSong?.id, songs, isLibraryOpen]);

  // Auto-navigate to playing song's location if it's not in the current list
  useEffect(() => {
    if (activeSource && currentSong && !searchQuery) {
      const isInCurrentList = songs.some(s => s.id === currentSong.id);
      if (!isInCurrentList) {
        // If the song is from the same source as active, switch folder to show it
        if (currentSong.isDrive && activeSource === 'cloud') {
          const folderName = currentSong.folder || "All Drive Songs";
          if (folders.has(folderName)) selectFolder(folderName);
        } else if (!currentSong.isDrive && activeSource === 'local' && currentSong.path) {
          const folderKey = currentSong.path.join('/');
          if (folders.has(folderKey)) selectFolder(folderKey);
        }
      }
    }
  }, [currentSong?.id]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if user is typing in search
      if (document.activeElement?.tagName === 'INPUT') return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        nextSong();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        prevSong();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, currentSongIndex, songs, playbackMode]);

  return (
    <div 
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="h-[100dvh] bg-[#0a0a0a] text-white font-sans selection:bg-blue-500/30 overflow-hidden flex flex-col relative"
    >
      {isDragging && (
        <div className="absolute inset-0 bg-black/85 backdrop-blur-md z-[500] border-4 border-dashed border-blue-500 m-4 rounded-3xl flex flex-col items-center justify-center pointer-events-none">
          <UploadCloud className="w-16 h-16 text-blue-400 animate-bounce mb-3" />
          <h3 className="text-xl font-bold text-white tracking-wide">Thả file FLAC hoặc thư mục nhạc vào đây</h3>
          <p className="text-xs text-blue-300 mt-1">Hỗ trợ giải mã FLAC 16/24-bit, 44.1 - 192 kHz, MP3, WAV</p>
        </div>
      )}
      {/* Header */}
      <header className="h-16 md:h-20 border-b border-white/10 flex items-center justify-between px-4 md:px-8 bg-black/20 backdrop-blur-md sticky top-0 z-[100] flex-shrink-0">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="w-8 h-8 md:w-10 md:h-10 bg-gradient-to-br from-blue-600 to-cyan-500 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Music className="w-5 h-5 md:w-6 md:h-6 text-white" />
          </div>
          <h1 className="text-lg md:text-2xl font-black tracking-tighter bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent hidden sm:block">
            VIBETUNE
          </h1>
        </div>

        <div ref={searchContainerRef} className="flex-1 max-w-[400px] mx-4 relative group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-blue-400 transition-colors" />
          <input 
            type="text" 
            placeholder={rootFolderName ? `Search in ${rootFolderName}...` : "Search music..."}
            value={searchQuery}
            onFocus={handleSearchFocus}
            onChange={handleSearchChange}
            className="bg-white/5 border border-white/10 rounded-full py-2 md:py-2.5 pl-10 pr-4 w-full focus:outline-none focus:ring-2 focus:ring-[#0070f3]/50 focus:bg-white/10 transition-all text-base shadow-inner"
          />
          
          <AnimatePresence>
            {showSearchSuggestions && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="fixed md:absolute top-16 md:top-full left-0 right-0 md:mt-2 bg-[#1a1a1a] md:rounded-2xl border-b md:border border-white/10 shadow-2xl overflow-hidden z-[200] max-h-[80vh] md:max-h-[400px]"
              >
                  <div className="p-4 md:p-2">
                    {allSongs.length === 0 ? (
                      <div className="p-8 text-center text-gray-500">
                        <Music className="w-8 h-8 mx-auto mb-2 opacity-20" />
                        <p className="text-sm">No music imported yet.</p>
                        <p className="text-[10px] mt-1 opacity-60 text-blue-400">Open Library to add music</p>
                      </div>
                    ) : (
                      <>
                        <div className="px-3 py-2 text-[10px] font-bold text-gray-500 uppercase tracking-widest flex justify-between items-center">
                          <span>Songs Match</span>
                        </div>
                        
                        {songSuggestions.length > 0 ? (
                          <div className="max-h-[350px] overflow-y-auto custom-scrollbar">
                            {songSuggestions.map(song => (
                              <button 
                                key={song.id}
                                onClick={() => {
                                  // Search within the current active source
                                  const sourceSongs = allSongs.filter(s => activeSource === 'cloud' ? s.isDrive : !s.isDrive);
                                  const index = sourceSongs.findIndex(s => s.id === song.id);
                                  setSongs(sourceSongs);
                                  // If at root, stay at root but show "Search Results" or similar as virtual folder
                                  setCurrentFolder(activeSource === 'cloud' ? "Cloud All Songs" : "Local All Songs");
                                  setCurrentSongIndex(index);
                                  setIsPlaying(true);
                                  setSearchQuery('');
                                  setShowSearchSuggestions(false);
                                }}
                                className="w-full flex items-center gap-3 p-4 md:p-3 hover:bg-blue-600/20 text-white rounded-xl transition-all text-sm text-left group"
                              >
                                <div className="w-10 h-10 bg-white/5 rounded-lg overflow-hidden flex-shrink-0">
                                  <img src={song.cover} alt="" className="w-full h-full object-cover" />
                                </div>
                                <div className="flex-1 truncate">
                                  <p className="font-bold truncate group-hover:text-blue-300 transition-colors">{song.name}</p>
                                  <p className="text-[11px] text-gray-500">{song.artist}</p>
                                </div>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="p-12 text-center text-gray-500">
                            <Search className="w-10 h-10 mx-auto mb-4 opacity-20" />
                            <p className="text-sm">No songs matching "{searchQuery}"</p>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
        </div>

        <div className="flex items-center gap-2 md:gap-4">
          <button 
            onClick={() => setIsLibraryOpen(!isLibraryOpen)}
            className={`p-2 md:p-2.5 rounded-xl transition-all group flex items-center gap-2 border ${isLibraryOpen ? 'bg-blue-600/20 border-blue-500/50 text-blue-400' : 'bg-white/5 border-white/5 text-gray-400 hover:bg-white/10'}`}
            title={isLibraryOpen ? "Close Library" : "Open Library"}
          >
            <ListMusic className="w-5 h-5 group-hover:text-blue-400" />
            <span className="text-xs font-bold hidden sm:block">Library</span>
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col md:flex-row overflow-hidden relative">


        {/* Mobile Drawer Library (Mobile Mode) */}
        <AnimatePresence>
          {isLibraryOpen && (
            <>
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsLibraryOpen(false)}
                className="md:hidden fixed inset-0 bg-black/80 backdrop-blur-sm z-[150]"
              />
              
              <motion.div 
                key="mobile-library"
                drag="y"
                dragControls={dragControls}
                dragListener={false}
                dragConstraints={{ top: 0 }}
                dragElastic={0.2}
                onDragEnd={(_, info) => {
                  if (info.offset.y > 100) setIsLibraryOpen(false);
                }}
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%', opacity: 0 }}
                transition={{ 
                  type: 'spring', 
                  damping: 32, 
                  stiffness: 180,
                  opacity: { duration: 0.15 } 
                }}
                className="md:hidden fixed bottom-0 left-0 right-0 h-[90vh] bg-[#0c0c0c] border-t border-white/10 z-[160] flex flex-col rounded-t-[32px] shadow-2xl overflow-hidden"
              >
                <div 
                  className="cursor-grab active:cursor-grabbing touch-none"
                  onPointerDown={(e) => dragControls.start(e)}
                >
                  <div className="flex justify-center pt-3 pb-3">
                    <div className="w-12 h-1.5 bg-white/20 rounded-full" />
                  </div>

                  <div className="pl-8 pr-4 py-6 flex items-center justify-between">
                    <div className="flex-1 overflow-hidden pr-6">
                      {activeSource === 'cloud' && isGoogleLinked && googleUser ? (
                        <div className="flex items-center gap-4">
                          <img src={googleUser.picture} className="w-14 h-14 rounded-full border-2 border-blue-500/30 shadow-lg" alt="" referrerPolicy="no-referrer" />
                          <div className="overflow-hidden">
                            <p className="font-black text-blue-400 text-lg uppercase leading-none truncate">{googleUser.name}</p>
                            <p className="text-[9px] text-blue-400/50 font-bold uppercase tracking-widest mt-1.5">Cloud Connected</p>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-4">
                          <div className="w-14 h-14 bg-blue-500/10 rounded-full flex items-center justify-center border-2 border-blue-500/20">
                            <ListMusic className="w-7 h-7 text-blue-400" />
                          </div>
                          <div className="overflow-hidden">
                            <p className="font-black text-white text-lg uppercase leading-none truncate">Library</p>
                            <p className="text-[9px] text-gray-500 font-bold uppercase tracking-widest mt-1.5">{activeSource === 'local' && rootFolderName ? 'Local Folder' : 'Select Source'}</p>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2" onPointerDown={e => e.stopPropagation()}>
                      <button 
                        onClick={triggerFolderSelect}
                        className={`p-2.5 rounded-xl transition-colors ${activeSource === 'local' ? 'bg-red-500/10 text-red-500' : 'bg-blue-500/10 text-blue-400'}`}
                        title="Mở Thư mục"
                      >
                        <FolderOpen className="w-5 h-5" />
                      </button>
                      <button 
                        onClick={switchToCloudSource}
                        className={`p-2.5 rounded-xl transition-colors ${activeSource === 'cloud' ? 'bg-red-500/10 text-red-500' : 'bg-blue-500/10 text-blue-400'}`}
                        title="Cloud"
                      >
                        <Cloud className={`w-5 h-5 ${isLoadingDrive ? 'animate-pulse' : ''}`} />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-hidden flex flex-col p-4">
                  {renderFolderNotification()}
                  {(currentFolder || (activeSource === 'local' && currentPath.length > (rootFolderName ? 1 : 0))) && (
                    <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl flex items-center gap-3 mb-6">
                      <button onClick={goBack} className="p-2 bg-blue-500/20 hover:bg-blue-500/30 rounded-lg transition-colors">
                        <SkipBack className="w-4 h-4 text-blue-400" />
                      </button>
                      <div className="flex-1 overflow-hidden">
                        <p className="text-sm font-bold text-blue-400 truncate">{currentFolder || "Main Directory"}</p>
                        <p className="text-xs text-blue-400/60">{songs.length} items</p>
                      </div>
                      <button onClick={resetFilter} className="p-1">
                        <X className="w-5 h-5 text-blue-400" />
                      </button>
                    </div>
                  )}

                  <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar pb-12">
                    {searchQuery === "" && (
                      <div className="mb-6 space-y-2">
                        {visibleFolders.length > 0 && !currentFolder?.includes('All Songs') && (
                          <div className="px-1 py-1 text-[10px] font-bold text-gray-500 uppercase tracking-widest flex justify-between items-center">
                            <span>Folders / Categories</span>
                          </div>
                        )}
                        {!currentFolder?.includes('All Songs') && visibleFolders.map(name => {
                          const folderSongs = folders.get(name) || [];
                          const isDriveFolder = folderSongs.some(s => s.isDrive);
                          const isVirtual = name.includes('All Songs');
                          const displayName = name === "All Local Songs" ? "All Songs" : name.split('/').pop();

                          return (
                            <button 
                              key={name}
                              onClick={() => selectFolder(name)}
                              className="w-full flex items-center gap-4 p-4 bg-white/5 hover:bg-blue-600/10 text-white rounded-2xl transition-all text-sm text-left group"
                            >
                              <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors ${
                                isVirtual ? 'bg-amber-500/10 group-hover:bg-amber-500/20' :
                                isDriveFolder ? 'bg-blue-500/10 group-hover:bg-blue-500/20' : 
                                'bg-white/5 group-hover:bg-white/10'
                              }`}>
                                {isVirtual ? (
                                  <Music className="w-6 h-6 text-gray-400 group-hover:text-amber-400" />
                                ) : isDriveFolder ? (
                                  <Cloud className="w-6 h-6 text-gray-400 group-hover:text-blue-400" />
                                ) : (
                                  <FolderOpen className="w-6 h-6 text-gray-400 group-hover:text-blue-400" />
                                )}
                              </div>
                              <div className="flex-1 truncate">
                                <p className={`font-bold text-base truncate group-hover:text-blue-300 transition-colors ${isVirtual ? 'text-amber-200' : ''}`}>{displayName}</p>
                                <p className="text-xs text-gray-500">
                                  {isVirtual ? allSongs.filter(s => activeSource === 'cloud' ? s.isDrive : (!s.isDrive && (name === "All Local Songs" || s.path?.join('/').startsWith(name.replace(' (All Songs)', ''))))).length : folderSongs.length} tracks
                                </p>
                              </div>
                            </button>
                          );
                        })}
                        {currentFolder && !currentFolder.includes('All Songs') && visibleFolders.length > 0 && <div className="border-b border-white/5 my-6" />}
                        {currentFolder && !currentFolder.includes('All Songs') && (
                          <div className="px-1 py-1 text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                            Tracks in Folder
                          </div>
                        )}
                      </div>
                    )}
                    {renderSongList()}
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        <div className={`flex-1 flex flex-col bg-[#110c1c] overflow-hidden relative transition-all duration-300 ease-in-out ${isLibraryOpen ? 'md:mr-[380px]' : 'md:mr-0'}`}>
          <div className="absolute inset-0 bg-gradient-to-br from-[#1a1427] to-[#0a0a0a] pointer-events-none" />
          
          <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-12 z-10 relative w-full h-full">
            <AnimatePresence mode="wait">
              {!showLyricsView ? (
                <motion.div 
                  key="album-art"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.05 }}
                  transition={{ duration: 0.4 }}
                  className="relative group max-w-[260px] md:max-w-[360px] aspect-square w-full my-12"
                >
                  <img 
                    src={currentSong?.cover || 'https://picsum.photos/seed/music/800/800'} 
                    alt="Cover" 
                    className="w-full h-full rounded-2xl object-cover shadow-[0_20px_50px_rgba(0,0,0,0.5)] relative z-10"
                    referrerPolicy="no-referrer"
                  />
                  {isPlaying && (
                    <div className="absolute bottom-6 left-6 z-20 flex items-end gap-1.5 px-4 py-3 bg-black/40 backdrop-blur-xl rounded-xl border border-white/10">
                      <motion.div animate={{ height: [6, 18, 6] }} transition={{ repeat: Infinity, duration: 0.6 }} className="w-1.5 bg-white rounded-full" />
                      <motion.div animate={{ height: [12, 6, 12] }} transition={{ repeat: Infinity, duration: 0.8 }} className="w-1.5 bg-white rounded-full" />
                      <motion.div animate={{ height: [6, 15, 6] }} transition={{ repeat: Infinity, duration: 0.7 }} className="w-1.5 bg-white rounded-full" />
                    </div>
                  )}
                </motion.div>
              ) : (
                <motion.div 
                  key="lyrics-view"
                  initial={{ opacity: 0, scale: 1.05 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.4 }}
                  className="w-full max-w-4xl h-full flex flex-col justify-center"
                >
                  <div className="flex flex-col items-center justify-center space-y-8 md:space-y-12">
                    <AnimatePresence mode="wait">
                      {currentSong?.lyrics && currentSong.lyrics.length > 0 ? (
                        <motion.div 
                          key={currentLyricIndex}
                          initial={{ opacity: 0, y: 30 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -30 }}
                          className="flex flex-col items-center space-y-8 md:space-y-12 w-full"
                        >
                          {currentLyricIndex > 0 ? (
                            <p className="text-xl md:text-2xl font-bold text-white/10 text-center line-clamp-1 max-w-[90%] blur-[1px]">
                              {currentSong.lyrics[currentLyricIndex - 1].text}
                            </p>
                          ) : (
                            <div className="h-10 md:h-12 invisible" />
                          )}
                          
                          <p className="text-2xl md:text-3xl lg:text-4xl font-black text-[#fbbf24] text-center drop-shadow-[0_0_30px_rgba(251,191,36,0.4)] leading-tight max-w-full px-4">
                            {currentSong.lyrics[currentLyricIndex === -1 ? 0 : currentLyricIndex].text}
                          </p>

                          {currentLyricIndex < currentSong.lyrics.length - 1 ? (
                            <p className="text-xl md:text-2xl font-bold text-white/20 text-center line-clamp-1 max-w-[90%] blur-[0.5px]">
                              {currentSong.lyrics[currentLyricIndex === -1 ? 1 : currentLyricIndex + 1].text}
                            </p>
                          ) : (
                            <div className="h-10 md:h-12 invisible" />
                          )}
                        </motion.div>
                      ) : (isLyricsLoading || isSearchingLyrics) ? (
                        <div className="flex flex-col items-center justify-center space-y-6">
                           <div className="relative">
                             <motion.div 
                               className="w-16 h-16 border-4 border-blue-500/20 rounded-full"
                               animate={{ scale: [1, 1.1, 1] }}
                               transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                             />
                             <motion.div 
                               className="absolute inset-0 border-4 border-t-blue-500 rounded-full"
                               animate={{ rotate: 360 }}
                               transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                             />
                           </div>
                           <div className="text-center space-y-2">
                             <p className="text-blue-400 text-lg font-bold italic tracking-wider uppercase">
                               {isSearchingLyrics ? 'Syncing from LRCLIB' : 'Reading Metadata'}
                             </p>
                             <div className="flex gap-1 justify-center">
                               {[0, 1, 2].map(i => (
                                 <motion.div 
                                   key={i}
                                   className="w-1.5 h-1.5 bg-blue-500 rounded-full"
                                   animate={{ opacity: [0.3, 1, 0.3] }}
                                   transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                                 />
                               ))}
                             </div>
                           </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-gray-500 italic gap-6 text-center">
                          <Mic2 className="w-16 h-16 opacity-20 mb-2" />
                          <div className="space-y-4 px-6">
                            <p className="text-xl md:text-2xl font-medium text-gray-400">
                              {currentSong ? 'Lyrics not found' : 'Select a track'}
                            </p>
                            {currentSong && (
                              <div className="space-y-6">
                                <div className="space-y-1">
                                  <p className="text-sm font-bold text-gray-300 not-italic uppercase tracking-widest">{currentSong.name}</p>
                                  <p className="text-xs text-gray-500 not-italic">{currentSong.artist}</p>
                                </div>
                                <button
                                  onClick={() => handleFetchLyrics(currentSong, true)}
                                  disabled={isSearchingLyrics}
                                  className="mx-auto flex items-center gap-2 px-6 py-2.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-full transition-all text-[10px] font-black uppercase tracking-widest border border-blue-500/30 disabled:opacity-50"
                                >
                                  {isSearchingLyrics ? (
                                    <>
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      Searching...
                                    </>
                                  ) : (
                                    <>
                                      <RotateCcw className="w-3.5 h-3.5" />
                                      Retry Search
                                    </>
                                  )}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <button 
              onClick={() => setShowLyricsView(!showLyricsView)}
              className={`absolute bottom-4 right-4 md:bottom-8 md:right-8 p-3 md:p-4 rounded-full transition-all z-30 shadow-2xl backdrop-blur-md group ${showLyricsView ? 'bg-[#0070f3] text-white' : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white border border-white/10'}`}
              title="Toggle Lyrics"
            >
              <Mic2 className={`w-5 h-5 md:w-6 md:h-6 ${showLyricsView ? 'animate-pulse' : 'group-hover:scale-110 transition-transform'}`} />
            </button>
          </div>
        </div>

        {/* Desktop Sidebar Library (Web Mode) - Positioned on the Right */}
        <AnimatePresence mode="wait">
          {isLibraryOpen && (
            <motion.aside
              key="desktop-library"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 380, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ 
                type: 'spring', 
                damping: 30, 
                stiffness: 150,
                opacity: { duration: 0.2 }
              }}
              className="hidden md:flex flex-col border-l border-white/10 bg-[#0c0c0c] backdrop-blur-2xl overflow-hidden fixed top-16 md:top-20 bottom-0 right-0 z-40 shadow-2xl"
            >
              <div className="pl-6 pr-3 py-6 border-b border-white/5 flex items-center justify-between">
                <div className="flex-1 overflow-hidden pr-4">
                  {activeSource === 'cloud' && isGoogleLinked && googleUser ? (
                    <div className="flex items-center gap-3">
                      <img src={googleUser.picture} className="w-12 h-12 rounded-full border border-blue-500/30 shadow-md" alt="" referrerPolicy="no-referrer" />
                      <div className="overflow-hidden">
                        <p className="font-black text-blue-400 text-sm uppercase leading-none truncate">{googleUser.name}</p>
                        <p className="text-[9px] text-blue-400/40 font-bold uppercase tracking-widest mt-1">Cloud Storage</p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 bg-blue-500/10 rounded-full flex items-center justify-center border border-blue-500/20">
                        <ListMusic className="w-6 h-6 text-blue-400" />
                      </div>
                      <div className="overflow-hidden">
                        <p className="font-black text-white text-sm uppercase leading-none truncate">Library</p>
                        <p className="text-[9px] text-gray-500 font-bold uppercase tracking-widest mt-1">{activeSource === 'local' && rootFolderName ? 'Local Folder' : 'No Source'}</p>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button 
                    onClick={triggerFolderSelect}
                    className={`p-2 rounded-lg transition-colors flex items-center justify-center ${activeSource === 'local' ? 'bg-red-500/10 text-red-500' : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'}`}
                    title="Mở Thư mục chứa nhạc"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={switchToCloudSource}
                    className={`p-2 rounded-lg transition-colors flex items-center justify-center relative ${activeSource === 'cloud' ? 'bg-red-500/10 text-red-500' : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'}`}
                    title={isGoogleLinked ? "Google Drive" : "Kết nối Google Drive"}
                  >
                    <Cloud className={`w-4 h-4 ${isLoadingDrive ? 'animate-pulse' : ''}`} />
                    {isLoadingDrive && <RotateCcw className="w-3.5 h-3.5 absolute animate-spin opacity-50" />}
                  </button>
                  <button 
                    onClick={() => setIsLibraryOpen(false)}
                    className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-gray-400 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-hidden flex flex-col p-2 pt-4">
                {renderFolderNotification()}
                {currentFolder && (
                  <div className="mx-2 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl flex items-center gap-3 mb-4">
                    <button 
                      onClick={goBack} 
                      className="p-1.5 bg-blue-500/20 hover:bg-blue-500/30 rounded-lg transition-colors"
                      title="Go Back"
                    >
                      <SkipBack className="w-3.5 h-3.5 text-blue-400" />
                    </button>
                    <div className="flex-1 overflow-hidden">
                      <p className="text-xs font-bold text-blue-400 truncate">{currentFolder}</p>
                      <p className="text-[10px] text-blue-400/60">{songs.length} tracks</p>
                    </div>
                    <button onClick={resetFilter} className="text-blue-400 hover:text-white" title="Reset All">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto px-2 space-y-1 custom-scrollbar">
                  {searchQuery === "" && (
                    <div className="mb-6 space-y-1">
                      {visibleFolders.length > 0 && !currentFolder?.includes('All Songs') && (
                        <div className="px-3 py-2 text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                          Folders / Categories
                        </div>
                      )}
                      {!currentFolder?.includes('All Songs') && visibleFolders.map(name => {
                        const folderSongs = folders.get(name) || [];
                        const isDriveFolder = folderSongs.some(s => s.isDrive);
                        const isVirtual = name.includes('All Songs');
                        const displayName = name === "All Local Songs" ? "All Songs" : name.split('/').pop();
                        
                        return (
                          <button 
                            key={name}
                            onClick={() => selectFolder(name)}
                            className="w-full flex items-center gap-3 p-3 hover:bg-blue-600/10 text-white rounded-xl transition-all text-sm text-left group border border-transparent"
                          >
                            <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
                              isVirtual ? 'bg-amber-500/10 group-hover:bg-amber-500/20' : 
                              isDriveFolder ? 'bg-blue-500/10 group-hover:bg-blue-500/20' : 
                              'bg-white/5 group-hover:bg-white/10'
                            }`}>
                              {isVirtual ? (
                                <Music className={`w-5 h-5 ${currentFolder === displayName ? 'text-amber-400' : 'text-gray-400 group-hover:text-amber-400'}`} />
                              ) : isDriveFolder ? (
                                <Cloud className={`w-5 h-5 ${currentFolder === displayName ? 'text-blue-400' : 'text-gray-400 group-hover:text-blue-400'}`} />
                              ) : (
                                <FolderOpen className={`w-5 h-5 ${currentFolder === displayName ? 'text-blue-400' : 'text-gray-400 group-hover:text-blue-400'}`} />
                              )}
                            </div>
                            <div className="flex-1 truncate">
                              <p className={`font-bold truncate transition-colors ${
                                currentFolder === displayName ? (isVirtual ? 'text-amber-300' : 'text-blue-300') : 'group-hover:text-blue-300'
                              }`}>{displayName}</p>
                              <p className="text-[11px] text-gray-500">
                                {isVirtual ? allSongs.filter(s => activeSource === 'cloud' ? s.isDrive : (!s.isDrive && (name === "All Local Songs" || s.path?.join('/').startsWith(name.replace(' (All Songs)', ''))))).length : folderSongs.length} tracks
                              </p>
                            </div>
                          </button>
                        );
                      })}
                      {currentFolder && !currentFolder.includes('All Songs') && visibleFolders.length > 0 && (
                        <>
                          <div className="border-b border-white/5 my-4 mx-2" />
                          <div className="px-3 py-2 text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                            Tracks in Folder
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {renderSongList()}
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </main>

      <footer className={`bg-[#0a0a0a]/95 backdrop-blur-2xl border-t border-white/5 z-50 px-4 md:px-6 py-4 md:py-6 h-auto flex-shrink-0 sticky bottom-0 transition-all duration-300 ease-in-out ${isLibraryOpen ? 'md:mr-[380px]' : 'md:mr-0'}`}>
        <div className="max-w-3xl mx-auto flex flex-col items-center gap-4">
          <div className="text-center flex flex-col items-center">
            <AnimatePresence mode="wait">
              {currentSong && (
                <motion.div
                  key={currentSong.id}
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -10, opacity: 0 }}
                  className="flex flex-wrap items-center justify-center gap-2"
                >
                  <h3 className="text-base md:text-lg font-bold text-white tracking-wide truncate max-w-[85vw] sm:max-w-md">
                    {currentSong.name} <span className="text-gray-500 font-normal"> - {currentSong.artist}</span>
                  </h3>
                  {currentSong.isFlac ? (
                    <button
                      type="button"
                      title="Bấm để xem thông số kỹ thuật âm thanh"
                      onClick={() => setShowTechnicalModal(true)}
                      className="px-2.5 py-0.5 bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30 rounded-full text-[10px] font-black tracking-wider uppercase shadow-[0_0_10px_rgba(6,182,212,0.2)] flex items-center gap-1.5 transition-all transform hover:scale-105 cursor-pointer"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                      {currentSong.qualityBadge || 'FLAC Lossless'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      title="Bấm để xem thông số kỹ thuật âm thanh"
                      onClick={() => setShowTechnicalModal(true)}
                      className="px-2.5 py-0.5 bg-white/10 hover:bg-white/20 text-gray-300 hover:text-white border border-white/15 rounded-full text-[10px] font-bold tracking-wider uppercase transition-all transform hover:scale-105 cursor-pointer"
                    >
                      {currentSong.audioType || 'Standard Audio'}
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {audioErrorMessage && (
              <div className="mt-1.5 text-xs text-red-300 bg-red-500/20 border border-red-500/30 px-3 py-1 rounded-full flex items-center gap-2 max-w-md shadow-lg">
                <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                <span className="truncate">{audioErrorMessage}</span>
                <button onClick={() => setAudioErrorMessage(null)} className="ml-1 text-white/60 hover:text-white flex-shrink-0">
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          <div className="w-full flex items-center gap-4">
            <span className="text-[10px] md:text-xs font-medium text-blue-500/70 w-10 text-right">{formatTime(currentTime)}</span>
            <div className="flex-1 relative h-1.5 md:h-1 bg-white/10 rounded-full">
              <input 
                type="range" 
                min="0" 
                max={duration || 0} 
                step="0.1"
                value={currentTime} 
                onChange={handleSeek}
                className="absolute inset-0 w-full opacity-0 cursor-pointer z-20 appearance-none bg-transparent"
              />
              <motion.div 
                className="absolute inset-y-0 left-0 bg-[#0070f3] rounded-full shadow-[0_0_20px_rgba(0,112,243,0.7)]"
                style={{ width: `${(currentTime / duration) * 100}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2 h-2 md:w-2.5 md:h-2.5 bg-white border-2 border-[#0070f3] rounded-full shadow-[0_0_15px_rgba(0,112,243,0.9)] z-30" />
              </motion.div>
            </div>
            <span className="text-[10px] md:text-xs font-medium text-blue-500/70 w-10">{formatTime(duration)}</span>
          </div>

          <div className="flex items-center gap-6 md:gap-10 mt-2 relative w-full justify-center">
            <div className="flex items-center gap-6 md:gap-10">
              <button 
                onClick={() => {
                  const modes: ('normal' | 'shuffle' | 'repeat')[] = ['normal', 'shuffle', 'repeat'];
                  const nextMode = modes[(modes.indexOf(playbackMode) + 1) % modes.length];
                  setPlaybackMode(nextMode);
                }}
                className={`p-2 rounded-full transition-all flex items-center justify-center relative ${playbackMode !== 'normal' ? 'bg-[#0070f3]/20 text-[#0070f3]' : 'text-gray-500 hover:text-white'}`}
                title={playbackMode === 'shuffle' ? 'Shuffle' : playbackMode === 'repeat' ? 'Repeat' : 'Normal'}
              >
                {playbackMode === 'shuffle' ? <Shuffle className="w-5 h-5 md:w-6 md:h-6" /> : <Repeat className="w-5 h-5 md:w-6 md:h-6" />}
              </button>

              <button 
                onClick={prevSong}
                className="text-[#0070f3] hover:scale-110 transition-transform p-1 drop-shadow-[0_0_8px_rgba(0,112,243,0.5)]"
              >
                <SkipBack className="w-6 h-6 md:w-8 md:h-8 fill-current" />
              </button>
              <button 
                onClick={togglePlay}
                className="w-12 h-12 md:w-16 md:h-16 border-2 border-[#0070f3]/40 text-[#0070f3] rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-all bg-[#0070f3]/5 shadow-[0_0_20px_rgba(0,112,243,0.2)]"
              >
                {isPlaying ? <Pause className="w-6 h-6 md:w-8 md:h-8 fill-current" /> : <Play className="w-6 h-6 md:w-8 md:h-8 fill-current ml-1" />}
              </button>
              <button 
                onClick={nextSong}
                className="text-[#0070f3] hover:scale-110 transition-transform p-1 drop-shadow-[0_0_8px_rgba(0,112,243,0.5)]"
              >
                <SkipForward className="w-6 h-6 md:w-8 md:h-8 fill-current" />
              </button>
              <button 
                onClick={handleReplay}
                className="p-2 text-[#0070f3]/60 hover:text-[#0070f3] transition-colors"
                title="Replay"
              >
                <RotateCcw className="w-5 h-5 md:w-6 md:h-6" />
              </button>
            </div>

            {/* Volume Control - Desktop Right */}
            <div className="hidden md:flex items-center gap-3 absolute right-0 group">
              <button 
                onClick={toggleMute}
                className="text-gray-500 hover:text-white transition-colors"
              >
                {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : volume < 0.5 ? <Volume1 className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>
              <div className="w-24 h-1 bg-white/10 rounded-full relative overflow-hidden group-hover:bg-white/20 transition-colors">
                <input 
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="absolute inset-0 w-full opacity-0 cursor-pointer z-10"
                />
                <motion.div 
                  className="absolute inset-y-0 left-0 bg-blue-500"
                  style={{ width: `${(isMuted ? 0 : volume) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </footer>

      <audio
        ref={audioRef}
        src={currentSong?.audioUrl}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={nextSong}
        onError={handleAudioError}
      />

      <input
        type="file"
        ref={fileInputFolderRef}
        onChange={handleFolderChange}
        className="hidden"
        // @ts-ignore
        webkitdirectory=""
        directory=""
        multiple
      />

      <input
        type="file"
        ref={fileInputFilesRef}
        onChange={handleFilesChange}
        className="hidden"
        accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.alac,.aif,.aiff,.webm,.weba,.wma,.m4b,.mp4,.lrc,.txt"
        multiple
      />

      <AudioTechnicalModal
        isOpen={showTechnicalModal}
        onClose={() => setShowTechnicalModal(false)}
        songName={currentSong?.name || 'Chưa chọn bài hát'}
        artist={currentSong?.artist || 'Unknown Artist'}
        album={currentSong?.album}
        cover={currentSong?.cover}
        specs={currentSong?.techInfo}
        outputInfo={outputInfo}
        sourceFile={currentSong?.sourceFile}
        isDrive={currentSong?.isDrive}
      />
    </div>
  );
}
