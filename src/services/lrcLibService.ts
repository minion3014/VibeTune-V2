
export interface LRCLibResponse {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string;
  syncedLyrics: string;
}

export async function fetchLyricsFromLRCLib(trackName: string, artistName: string, duration?: number): Promise<string | null> {
  try {
    const query = new URLSearchParams({
      track_name: trackName,
      artist_name: artistName,
    });
    if (duration) query.append('duration', Math.round(duration).toString());

    // Call our backend proxy instead of lrclib.net directly to avoid CORS issues
    const response = await fetch(`/api/lyrics/search?${query.toString()}`);
    
    if (response.ok) {
      const data: LRCLibResponse = await response.json();
      return data.syncedLyrics || data.plainLyrics || null;
    }

    return null;
  } catch (error) {
    console.error('Error fetching from backend lyrics proxy:', error);
    return null;
  }
}
