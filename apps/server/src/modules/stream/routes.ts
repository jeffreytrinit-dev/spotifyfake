import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_PLAYABLE_FORMATS,
  IdSchema,
  StreamQuerySchema,
  TRANSCODE_PROFILES,
  originalFormat,
  planStream,
  type PlayableFormat,
  type QualityTier,
  type StreamInfoDto,
  type StreamPlan,
  type TranscodeProfileId,
} from '@tidepool/shared';
import type { Db } from '../../db.js';
import { AppError, notFound } from '../../errors.js';
import { PathTraversalError, resolveRealInside } from '../../lib/safe-path.js';
import { parse } from '../../lib/validate.js';
import { currentUser } from '../auth/plugin.js';
import { getSettings } from '../users/settings.js';
import { sendFile } from './send-file.js';
import type { TranscodeSource, Transcoder } from './transcoder.js';

const Params = z.object({ trackId: IdSchema });

/** MIME types for originals, by PlayableFormat (container-level, no codecs parameter). */
const ORIGINAL_MIME: Record<PlayableFormat, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  'mp4-aac': 'audio/mp4',
  'mp4-alac': 'audio/mp4',
  flac: 'audio/flac',
  'ogg-opus': 'audio/ogg',
  'ogg-vorbis': 'audio/ogg',
  'webm-opus': 'audio/webm',
  wav: 'audio/wav',
};

const trackSelect = {
  id: true,
  path: true,
  container: true,
  codec: true,
  lossless: true,
  bitrate: true,
  fileSize: true,
  durationMs: true,
  quickHash: true,
} as const;

type StreamTrack = {
  id: string;
  path: string;
  container: string;
  codec: string;
  lossless: boolean;
  bitrate: number | null;
  fileSize: bigint;
  durationMs: number;
  quickHash: string;
};

function sourceKbps(t: StreamTrack): number {
  if (t.bitrate) return Math.round(t.bitrate / 1000);
  return t.durationMs > 0 ? Math.round((Number(t.fileSize) * 8) / t.durationMs) : 0;
}

export async function streamRoutes(
  app: FastifyInstance,
  opts: { db: Db; transcoder: Transcoder; musicDir: string },
): Promise<void> {
  const { db, transcoder } = opts;

  async function loadTrack(req: FastifyRequest): Promise<{ track: StreamTrack; absPath: string }> {
    const { trackId } = parse(Params, req.params);
    const track = await db.track.findFirst({
      where: { id: trackId, missingSince: null },
      select: trackSelect,
    });
    if (!track) throw notFound('Track');
    let absPath: string;
    try {
      absPath = await resolveRealInside(opts.musicDir, track.path);
    } catch (err) {
      if (err instanceof PathTraversalError) throw err;
      throw new AppError(404, 'TRACK_FILE_MISSING', 'The audio file for this track is not on disk');
    }
    return { track, absPath };
  }

  async function resolvePlan(req: FastifyRequest, track: StreamTrack) {
    const q = parse(StreamQuerySchema, req.query);
    const tier: QualityTier = q.q ?? (await getSettings(db, currentUser(req).id)).streamQualityWifi;
    const formats = q.formats?.length ? q.formats : [...DEFAULT_PLAYABLE_FORMATS];
    const plan = planStream(
      {
        container: track.container,
        codec: track.codec,
        lossless: track.lossless,
        kbps: sourceKbps(track),
      },
      tier,
      formats,
    );
    return { q, tier, formats, plan };
  }

  function sendOriginal(
    req: FastifyRequest,
    reply: FastifyReply,
    track: StreamTrack,
    absPath: string,
    extra: Record<string, string> = {},
  ) {
    const fmt = originalFormat(track);
    return sendFile(req, reply, absPath, {
      mime: fmt ? ORIGINAL_MIME[fmt] : 'application/octet-stream',
      etag: `"o-${track.quickHash.slice(0, 20)}"`,
      headers: { 'X-Tidepool-Source': 'original', ...extra },
    });
  }

  /** Transcoding is impossible right now: send the original if the client can play it. */
  function fallback(
    req: FastifyRequest,
    reply: FastifyReply,
    track: StreamTrack,
    absPath: string,
    formats: PlayableFormat[],
    cause?: unknown,
  ) {
    const fmt = originalFormat(track);
    if (fmt && formats.includes(fmt)) {
      req.log.warn({ trackId: track.id, err: cause }, 'transcode unavailable; serving original');
      return sendOriginal(req, reply, track, absPath, { 'X-Tidepool-Fallback': 'original' });
    }
    throw new AppError(
      502,
      'TRANSCODE_FAILED',
      'This track could not be converted to a format your device plays',
    );
  }

  function sendCached(
    req: FastifyRequest,
    reply: FastifyReply,
    file: string,
    profile: TranscodeProfileId,
    sourceHash: string,
  ) {
    return sendFile(req, reply, file, {
      mime: TRANSCODE_PROFILES[profile].mime,
      etag: `"t-${profile}-${sourceHash.slice(0, 20)}"`,
      headers: { 'X-Tidepool-Source': 'transcode', 'X-Tidepool-Profile': profile },
    });
  }

  app.get('/stream/:trackId', async (req, reply) => {
    const { track, absPath } = await loadTrack(req);
    const { q, formats, plan } = await resolvePlan(req, track);
    if (plan.kind === 'original') return sendOriginal(req, reply, track, absPath);

    const { profile } = plan;
    const src: TranscodeSource = { id: track.id, absPath, quickHash: track.quickHash };
    const cached = await transcoder.lookup(src, profile);
    if (cached) return sendCached(req, reply, cached.file, profile, cached.sourceHash);
    if (transcoder.isBackingOff(track.id, profile))
      return fallback(req, reply, track, absPath, formats);

    const def = TRANSCODE_PROFILES[profile];
    if (req.method === 'HEAD') {
      // Don't start work for a HEAD; describe what a GET would stream.
      return reply
        .header('Content-Type', def.liveMime)
        .header('Accept-Ranges', 'none')
        .header('Cache-Control', 'no-store')
        .header('X-Tidepool-Source', 'transcode')
        .send();
    }

    const job = transcoder.ensure(src, profile, { live: !q.wait });
    if (q.wait || !job.liveAvailable) {
      try {
        const done = await job.done;
        return sendCached(req, reply, done.file, profile, done.sourceHash);
      } catch (err) {
        return fallback(req, reply, track, absPath, formats, err);
      }
    }

    // First play of an uncached transcode: stream it as ffmpeg produces it. No Range support
    // (the length isn't known yet); the next request for this track gets the cached file.
    let body;
    try {
      body = await job.openLiveStream();
    } catch (err) {
      return fallback(req, reply, track, absPath, formats, err);
    }
    req.raw.on('close', () => body.destroy());
    return reply
      .header('Content-Type', def.liveMime)
      .header('Accept-Ranges', 'none')
      .header('Cache-Control', 'no-store')
      .header('X-Tidepool-Source', 'transcode')
      .header('X-Tidepool-Profile', profile)
      .header('X-Tidepool-Live', '1')
      .header('X-Tidepool-Duration-Ms', String(track.durationMs))
      .send(body);
  });

  app.get('/stream/:trackId/original', async (req, reply) => {
    const { track, absPath } = await loadTrack(req);
    return sendOriginal(req, reply, track, absPath);
  });

  app.get('/stream/:trackId/info', async (req): Promise<StreamInfoDto> => {
    const { track, absPath } = await loadTrack(req);
    const { tier, plan } = await resolvePlan(req, track);
    return describe(track, absPath, tier, plan);
  });

  /** Warm the cache (e.g. for the next track in the queue) without waiting for it. */
  app.post('/stream/:trackId/prepare', async (req, reply): Promise<StreamInfoDto> => {
    const { track, absPath } = await loadTrack(req);
    const { tier, plan } = await resolvePlan(req, track);
    const info = await describe(track, absPath, tier, plan);
    if (
      plan.kind === 'transcode' &&
      !info.seekable &&
      !transcoder.isBackingOff(track.id, plan.profile)
    ) {
      transcoder.ensure({ id: track.id, absPath, quickHash: track.quickHash }, plan.profile);
      reply.code(202);
    }
    return info;
  });

  async function describe(
    track: StreamTrack,
    absPath: string,
    tier: QualityTier,
    plan: StreamPlan,
  ): Promise<StreamInfoDto> {
    if (plan.kind === 'original') {
      return {
        trackId: track.id,
        tier,
        source: 'original',
        profile: null,
        codec: track.codec,
        mime: ORIGINAL_MIME[plan.format],
        kbps: track.lossless ? null : sourceKbps(track),
        lossless: track.lossless,
        seekable: true,
        sizeBytes: Number(track.fileSize),
      };
    }
    const def = TRANSCODE_PROFILES[plan.profile];
    const cached = await transcoder.lookup(
      { id: track.id, absPath, quickHash: track.quickHash },
      plan.profile,
    );
    return {
      trackId: track.id,
      tier,
      source: 'transcode',
      profile: plan.profile,
      codec: def.codec,
      mime: cached ? def.mime : def.liveMime,
      kbps: def.kbps,
      lossless: def.codec === 'flac',
      seekable: cached !== null,
      sizeBytes: cached?.sizeBytes ?? null,
    };
  }
}
