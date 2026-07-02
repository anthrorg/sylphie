import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
let verboseMod: typeof import('./verbose');

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let logsDir: string;
let stderrSpy: jest.SpyInstance;

function currentLogFile(): string {
  return path.join(logsDir, `verbose.${process.pid}.log`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

beforeEach(() => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbose-spec-'));
  process.chdir(tmpDir);
  logsDir = path.join(tmpDir, 'logs');
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  verboseMod = require('./verbose');
});

afterEach(() => {
  // Close any open log stream before the tmp dir is removed, otherwise a
  // dangling async write can fire after cleanup and crash the process.
  delete process.env.VERBOSE;
  verboseMod.reconfigureVerbose();
  stderrSpy.mockRestore();
  process.env = { ...ORIGINAL_ENV };
  process.chdir(ORIGINAL_CWD);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('verbose log rotation (TK-INTAKE-1)', () => {
  test('AC1: rotates at threshold and starts a fresh file on next write', async () => {
    process.env.VERBOSE = '1';
    process.env.VERBOSE_MAX_BYTES = '100';
    fs.mkdirSync(logsDir, { recursive: true });
    // Pre-seed the current-pid file at/above the threshold.
    fs.writeFileSync(currentLogFile(), 'x'.repeat(150));

    verboseMod.reconfigureVerbose();
    verboseMod.verbose('Test', 'trigger line');

    await waitFor(() => fs.existsSync(`${currentLogFile()}.1`));

    const rotated = readFileSafe(`${currentLogFile()}.1`);
    expect(rotated.length).toBe(150);

    await waitFor(() => readFileSafe(currentLogFile()).includes('trigger line'));
    const fresh = readFileSafe(currentLogFile());
    expect(fresh).toContain('trigger line');
  });

  test('AC2: keeps only VERBOSE_KEEP rotated segments, oldest pruned', async () => {
    process.env.VERBOSE = '1';
    process.env.VERBOSE_MAX_BYTES = '10';
    process.env.VERBOSE_KEEP = '3';
    verboseMod.reconfigureVerbose();

    // Each write is well over 10 bytes, so every call rotates first.
    for (let i = 0; i < 5; i++) {
      verboseMod.verbose('Test', `line-${i}-padding-to-exceed-threshold`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 20)); // yield a tick between writes
    }

    await waitFor(() => fs.existsSync(`${currentLogFile()}.3`));

    expect(fs.existsSync(currentLogFile())).toBe(true);
    expect(fs.existsSync(`${currentLogFile()}.1`)).toBe(true);
    expect(fs.existsSync(`${currentLogFile()}.2`)).toBe(true);
    expect(fs.existsSync(`${currentLogFile()}.3`)).toBe(true);
    expect(fs.existsSync(`${currentLogFile()}.4`)).toBe(false);
  });

  test('AC3: triggering line lands only in the new file; stderr unaffected', async () => {
    process.env.VERBOSE = '1';
    process.env.VERBOSE_MAX_BYTES = '50';
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(currentLogFile(), 'y'.repeat(60));

    verboseMod.reconfigureVerbose();
    stderrSpy.mockClear();
    verboseMod.verbose('Test', 'unique-trigger-payload');

    await waitFor(() => fs.existsSync(`${currentLogFile()}.1`));
    await waitFor(() => readFileSafe(currentLogFile()).includes('unique-trigger-payload'));

    const rotatedContent = readFileSafe(`${currentLogFile()}.1`);
    expect(rotatedContent).not.toContain('unique-trigger-payload');
    const freshContent = readFileSafe(currentLogFile());
    expect(freshContent).toContain('unique-trigger-payload');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const stderrLine = stderrSpy.mock.calls[0][0] as string;
    expect(stderrLine).toContain('unique-trigger-payload');
    expect(freshContent).toContain(stderrLine.trimEnd());
  });

  test('AC4: rotation and pruning only touch the current pid, not a foreign pid', async () => {
    process.env.VERBOSE = '1';
    process.env.VERBOSE_MAX_BYTES = '50';
    fs.mkdirSync(logsDir, { recursive: true });

    const foreignFile = path.join(logsDir, 'verbose.99999.log');
    fs.writeFileSync(foreignFile, 'foreign-untouched-content');
    const foreignStatBefore = fs.statSync(foreignFile);

    fs.writeFileSync(currentLogFile(), 'z'.repeat(60));

    verboseMod.reconfigureVerbose();
    verboseMod.verbose('Test', 'own-pid-line');

    await waitFor(() => fs.existsSync(`${currentLogFile()}.1`));

    // Foreign file must be untouched (not rotated, not pruned, content identical).
    expect(fs.existsSync(foreignFile)).toBe(true);
    expect(readFileSafe(foreignFile)).toBe('foreign-untouched-content');
    const foreignStatAfter = fs.statSync(foreignFile);
    expect(foreignStatAfter.mtimeMs).toBe(foreignStatBefore.mtimeMs);
    expect(fs.existsSync(`${logsDir}/verbose.99999.log.1`)).toBe(false);
  });

  test('AC5: disabled hot path creates no logs dir or file', async () => {
    delete process.env.VERBOSE;
    verboseMod.reconfigureVerbose();
    verboseMod.verbose('Test', 'should not be written to disk');

    expect(fs.existsSync(logsDir)).toBe(false);
  });
});
