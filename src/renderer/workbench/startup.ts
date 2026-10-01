/**
 * How many files and folders the launch asked this window to open (command line, OS open
 * request). The editor waits for it before deciding whether to show the welcome page.
 */
let finish: (count: number) => void = () => undefined;

export const startupRequests = {
  promise: new Promise<number>((resolve) => {
    finish = resolve;
  }),
  done(count: number): void {
    finish(count);
  },
};
