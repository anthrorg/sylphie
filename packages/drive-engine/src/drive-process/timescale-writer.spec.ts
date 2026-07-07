/**
 * TK-133 (removal branch): the dead Timescale event-batch writer + emitter
 * are gone rather than fixed — DriveProcessManagerService already forwards
 * events over IPC and persists them from the main process with the correct
 * columns, so the child-side writer was both wrong-columned AND dead code
 * (its only consumer, EventEmitter, was never instantiated).
 */

import * as fs from 'fs';
import * as path from 'path';
import { TimescaleWriter } from './timescale-writer';

describe('TimescaleWriter (post-removal)', () => {
  it('no longer exposes the dead event-batch write path', () => {
    const proto = TimescaleWriter.prototype as any;
    expect(proto.writeBatch).toBeUndefined();
    expect(proto.buildInsertQuery).toBeUndefined();
  });

  it('still exposes the checkpoint save/restore path used across restarts', () => {
    const proto = TimescaleWriter.prototype as any;
    expect(typeof proto.saveState).toBe('function');
    expect(typeof proto.loadState).toBe('function');
    expect(typeof proto.ensureCheckpointTable).toBe('function');
  });

  it('event-emitter.ts no longer exists in the repo', () => {
    const deadFile = path.join(__dirname, 'event-emitter.ts');
    expect(fs.existsSync(deadFile)).toBe(false);
  });
});
