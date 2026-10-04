import { spawn } from 'node:child_process';

export class ProcessError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a binary (never via a shell) with a hard timeout. Output is capped to avoid
 * unbounded buffering when a tool misbehaves.
 */
export function run(
  command: string,
  args: readonly string[],
  { timeoutMs = 60_000, maxOutputBytes = 8 << 20 } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killedForTimeout = false;
    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxOutputBytes) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < maxOutputBytes) stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ProcessError(command, null, stderr, `${command} failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedForTimeout) {
        reject(
          new ProcessError(command, code, stderr, `${command} timed out after ${timeoutMs} ms`),
        );
      } else if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ');
        reject(new ProcessError(command, code, stderr, `${command} exited with ${code}: ${tail}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Duration in ms via ffprobe; used when tag parsing can't determine it. Returns null on failure. */
export async function probeDurationMs(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nw=1:nk=1',
        `file:${filePath}`,
      ],
      { timeoutMs: 30_000 },
    );
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}
