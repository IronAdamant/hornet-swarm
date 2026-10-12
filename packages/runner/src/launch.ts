/** `http2: false` makes Chromium use HTTP/1.1, for a site whose HTTP/2 is known to stall. */
export function browserLaunchOptions(options: { http2?: boolean } = {}): { headless: boolean; executablePath?: string; args: string[] } {
  const executablePath = process.env.AEGIS_BROWSER ?? (process.env.AEGIS_BROWSER_USER ? process.env.AEGIS_BROWSER_LAUNCH : undefined);
  return {
    headless: process.env.AEGIS_HEADLESS === '1',
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...(options.http2 === false ? ['--disable-http2'] : [])],
  };
}
