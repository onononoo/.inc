import { expect, test } from '@playwright/test';
import { launchInc, type IncInstance } from './harness';

let inc: IncInstance;

test.beforeAll(async () => {
  inc = await launchInc();
});

test.afterAll(async () => {
  await inc?.close();
});

test('boots into a sandboxed, isolated renderer', async () => {
  const { page } = inc;
  await expect(page.locator('#root')).not.toBeEmpty();

  const isolation = await page.evaluate(() => ({
    hasInc: typeof (window as unknown as { inc?: unknown }).inc === 'object',
    hasRequire: typeof (window as unknown as { require?: unknown }).require,
    hasProcess: typeof (window as unknown as { process?: unknown }).process,
    origin: location.origin,
  }));
  expect(isolation.hasInc).toBe(true);
  expect(isolation.hasRequire).toBe('undefined');
  expect(isolation.hasProcess).toBe('undefined');
  expect(isolation.origin).toBe('inc://app');
});

test('typed IPC round-trips and reports the product name', async () => {
  const info = await inc.invoke<{ name: string; platform: string }>('app:getInfo');
  expect(info.name).toBe('.inc');
});

test('rejects IPC channels that have no handler', async () => {
  await expect(inc.invoke('nope:missing')).rejects.toThrow();
});

test('makes no network requests and has no console errors', async () => {
  expect(inc.errors).toEqual([]);
});
