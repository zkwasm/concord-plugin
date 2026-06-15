import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { jailDownloadPath } from '../src/tools/files.js';

const CWD = path.resolve('/home/agent/project');

describe('jailDownloadPath (M9: download jail)', () => {
  it('allows a CWD-relative path', () => {
    expect(jailDownloadPath(CWD, 'out.bin')).toBe(path.join(CWD, 'out.bin'));
  });

  it('allows a nested CWD-relative path', () => {
    expect(jailDownloadPath(CWD, 'reports/v1.pdf')).toBe(path.join(CWD, 'reports/v1.pdf'));
  });

  it('allows an absolute path that stays inside the project', () => {
    expect(jailDownloadPath(CWD, path.join(CWD, 'sub/x'))).toBe(path.join(CWD, 'sub/x'));
  });

  it('rejects traversal that escapes the project', () => {
    expect(jailDownloadPath(CWD, '../../etc/passwd')).toBeNull();
  });

  it('rejects an absolute path outside the project (e.g. ~/.ssh)', () => {
    expect(jailDownloadPath(CWD, '/home/agent/.ssh/authorized_keys')).toBeNull();
  });

  it('rejects writing to the project dir itself', () => {
    expect(jailDownloadPath(CWD, '.')).toBeNull();
  });
});
