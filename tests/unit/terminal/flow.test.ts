import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FlowControl,
  HIGH_WATERMARK,
  LOW_WATERMARK,
} from '../../../src/main/terminal/flow-control';
import { FrameBatcher, FRAME_MS } from '../../../src/main/terminal/frame-batcher';
import { ReadyDetector } from '../../../src/main/terminal/ready-detector';
import { sanitizeTitle, TitleParser } from '../../../src/main/terminal/title-parser';

describe('FlowControl', () => {
  it('pauses once, only when the high watermark is exceeded', () => {
    const flow = new FlowControl(100, 10);
    expect(flow.sent(100)).toBeNull();
    expect(flow.paused).toBe(false);
    expect(flow.sent(1)).toBe('pause');
    expect(flow.paused).toBe(true);
    expect(flow.sent(500)).toBeNull();
    expect(flow.unacknowledged).toBe(601);
  });

  it('resumes only when the backlog falls to the low watermark', () => {
    const flow = new FlowControl(100, 10);
    flow.sent(200);
    expect(flow.acknowledge(100)).toBeNull();
    expect(flow.acknowledge(90)).toBeNull();
    expect(flow.unacknowledged).toBe(10);
    expect(flow.acknowledge(0)).toBe('resume');
    expect(flow.paused).toBe(false);
  });

  it('does not resume when it was never paused', () => {
    const flow = new FlowControl(100, 10);
    flow.sent(50);
    expect(flow.acknowledge(50)).toBeNull();
  });

  it('can pause again after resuming', () => {
    const flow = new FlowControl(100, 10);
    expect(flow.sent(150)).toBe('pause');
    expect(flow.acknowledge(150)).toBe('resume');
    expect(flow.sent(150)).toBe('pause');
  });

  it('never goes below zero, so a buggy or hostile renderer cannot gain credit', () => {
    const flow = new FlowControl(100, 10);
    flow.sent(20);
    flow.acknowledge(1_000_000);
    expect(flow.unacknowledged).toBe(0);
    expect(flow.sent(100)).toBeNull();
    expect(flow.sent(1)).toBe('pause');
  });

  it('ignores negative and fractional amounts', () => {
    const flow = new FlowControl(100, 10);
    flow.sent(-50);
    expect(flow.unacknowledged).toBe(0);
    flow.sent(10.9);
    expect(flow.unacknowledged).toBe(10);
    flow.acknowledge(-5);
    expect(flow.unacknowledged).toBe(10);
  });

  it('rejects invalid watermarks and has sensible defaults', () => {
    expect(() => new FlowControl(10, 10)).toThrow(RangeError);
    expect(() => new FlowControl(10, -1)).toThrow(RangeError);
    expect(HIGH_WATERMARK).toBeGreaterThan(LOW_WATERMARK);
    expect(new FlowControl().sent(HIGH_WATERMARK + 1)).toBe('pause');
  });
});

describe('FrameBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces chunks into one message per frame', () => {
    const out: string[] = [];
    const batcher = new FrameBatcher((d) => out.push(d));
    batcher.push('a');
    batcher.push('b');
    batcher.push('c');
    expect(out).toEqual([]);
    vi.advanceTimersByTime(FRAME_MS);
    expect(out).toEqual(['abc']);
    batcher.push('d');
    vi.advanceTimersByTime(FRAME_MS);
    expect(out).toEqual(['abc', 'd']);
  });

  it('sends a large backlog immediately', () => {
    const out: string[] = [];
    const batcher = new FrameBatcher((d) => out.push(d), FRAME_MS, 10);
    batcher.push('12345');
    batcher.push('67890');
    expect(out).toEqual(['1234567890']);
  });

  it('flushes on demand and ignores empty input', () => {
    const out: string[] = [];
    const batcher = new FrameBatcher((d) => out.push(d));
    batcher.push('');
    batcher.flush();
    batcher.push('x');
    batcher.flush();
    expect(out).toEqual(['x']);
    vi.advanceTimersByTime(100);
    expect(out).toEqual(['x']);
  });

  it('discards pending output and ignores input after dispose', () => {
    const out: string[] = [];
    const batcher = new FrameBatcher((d) => out.push(d));
    batcher.push('x');
    batcher.dispose();
    batcher.push('y');
    vi.advanceTimersByTime(100);
    expect(out).toEqual([]);
  });
});

describe('ReadyDetector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires after output has gone quiet', () => {
    const ready = vi.fn();
    const detector = new ReadyDetector(ready, 250, 5000);
    detector.activity();
    vi.advanceTimersByTime(200);
    detector.activity();
    vi.advanceTimersByTime(200);
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(ready).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('fires after the maximum wait when the shell never settles or prints nothing', () => {
    const noisy = vi.fn();
    const noisyDetector = new ReadyDetector(noisy, 250, 1000);
    for (let i = 0; i < 20; i++) {
      noisyDetector.activity();
      vi.advanceTimersByTime(100);
    }
    expect(noisy).toHaveBeenCalledTimes(1);

    const silent = vi.fn();
    new ReadyDetector(silent, 250, 1000);
    vi.advanceTimersByTime(1000);
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it('does not fire once cancelled', () => {
    const ready = vi.fn();
    const detector = new ReadyDetector(ready, 250, 1000);
    detector.activity();
    detector.cancel();
    vi.advanceTimersByTime(5000);
    expect(ready).not.toHaveBeenCalled();
  });
});

describe('TitleParser', () => {
  it('extracts titles ended by BEL or ST and ignores other sequences', () => {
    const parser = new TitleParser();
    expect(parser.feed('\u001b]0;first\u0007')).toEqual(['first']);
    expect(parser.feed('x\u001b]2;second\u001b\\y')).toEqual(['second']);
    expect(parser.feed('\u001b]7;file:///tmp\u0007')).toEqual([]);
    expect(parser.feed('\u001b[31mred\u001b[0m')).toEqual([]);
  });

  it('handles sequences split across chunks', () => {
    const parser = new TitleParser();
    expect(parser.feed('abc\u001b]0;pa')).toEqual([]);
    expect(parser.feed('rt\u0007tail')).toEqual(['part']);
    expect(parser.feed('\u001b')).toEqual([]);
    expect(parser.feed(']2;split-escape\u0007')).toEqual(['split-escape']);
  });

  it('reports each distinct title once and several per chunk in order', () => {
    const parser = new TitleParser();
    expect(parser.feed('\u001b]0;a\u0007\u001b]0;a\u0007\u001b]0;b\u0007')).toEqual(['a', 'b']);
    expect(parser.feed('\u001b]0;b\u0007')).toEqual([]);
    expect(parser.feed('\u001b]0;a\u0007')).toEqual(['a']);
  });

  it('drops empty titles and strips control characters and excess length', () => {
    const parser = new TitleParser();
    expect(parser.feed('\u001b]0;\u0007')).toEqual([]);
    expect(sanitizeTitle(' he\u0001llo\u007f ')).toBe('hello');
    expect(sanitizeTitle('x'.repeat(1000))).toHaveLength(256);
  });

  it('gives up on an endless unterminated sequence instead of buffering it', () => {
    const parser = new TitleParser();
    parser.feed('\u001b]0;' + 'x'.repeat(5000));
    expect(parser.feed('\u0007later')).toEqual([]);
    expect(parser.feed('\u001b]0;ok\u0007')).toEqual(['ok']);
  });
});
