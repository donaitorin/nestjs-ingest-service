import { Semaphore } from './semaphore';

describe('Semaphore', () => {
  it('never runs more tasks than it has permits, and runs them all', async () => {
    const semaphore = new Semaphore(3);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        semaphore.run(async () => {
          peak = Math.max(peak, ++running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running--;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(running).toBe(0);
  });

  it('releases the permit when a task throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok');
  });
});
