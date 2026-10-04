import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AlbumDetailDto,
  AlbumSummaryDto,
  LibraryStatsDto,
  MeResponse,
  MissingTrackDto,
  Page,
  ScanRunDto,
  UpdateUserSettings,
  UserSettingsDto,
} from '@tidepool/shared';
import { ApiError, api } from './client.js';
import { useTrackCache } from '../player/track-cache.js';

export const keys = {
  me: ['me'] as const,
  setup: ['setup'] as const,
  albums: (sort: string) => ['albums', sort] as const,
  album: (id: string) => ['album', id] as const,
  settings: ['settings'] as const,
  stats: ['library', 'stats'] as const,
  missing: ['library', 'missing'] as const,
};

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await api<MeResponse>('/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
    retry: 1,
  });
}

export function useSetupStatus(enabled: boolean) {
  return useQuery({
    queryKey: keys.setup,
    queryFn: () => api<{ needsSetup: boolean }>('/auth/setup'),
    enabled,
  });
}

export function useAlbums(sort: 'added' | 'name' = 'added', limit = 30) {
  return useInfiniteQuery({
    queryKey: keys.albums(sort),
    queryFn: ({ pageParam }) =>
      api<Page<AlbumSummaryDto>>(
        `/albums?sort=${sort}&limit=${limit}${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useAlbum(id: string) {
  return useQuery({
    queryKey: keys.album(id),
    queryFn: async () => {
      const album = await api<AlbumDetailDto>(`/albums/${id}`);
      useTrackCache.getState().put(album.tracks);
      return album;
    },
  });
}

export function useSettings(enabled = true) {
  return useQuery({
    queryKey: keys.settings,
    queryFn: () => api<UserSettingsDto>('/me/settings'),
    enabled,
    staleTime: 60_000,
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateUserSettings) =>
      api<UserSettingsDto>('/me/settings', { method: 'PATCH', body: patch }),
    onMutate: async (patch) => {
      // Optimistic: sliders and toggles respond instantly.
      await qc.cancelQueries({ queryKey: keys.settings });
      const prev = qc.getQueryData<UserSettingsDto>(keys.settings);
      if (prev) qc.setQueryData(keys.settings, { ...prev, ...patch });
      return { prev };
    },
    onError: (_e, _p, ctx) => ctx?.prev && qc.setQueryData(keys.settings, ctx.prev),
    onSuccess: (data) => qc.setQueryData(keys.settings, data),
  });
}

export function useLibraryStats() {
  return useQuery({ queryKey: keys.stats, queryFn: () => api<LibraryStatsDto>('/library/stats') });
}

export function useMissingTracks() {
  return useQuery({
    queryKey: keys.missing,
    queryFn: () => api<Page<MissingTrackDto>>('/library/missing?limit=200'),
  });
}

export function usePurgeMissing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trackIds?: string[]) =>
      api<ScanRunDto>('/library/missing/purge', {
        method: 'POST',
        body: trackIds ? { trackIds } : {},
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['library'] });
      void qc.invalidateQueries({ queryKey: ['albums'] });
    },
  });
}

export function useRescan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ scanId: string }>('/library/scan', { method: 'POST', body: {} }),
    onSuccess: () => setTimeout(() => void qc.invalidateQueries(), 3000),
  });
}
