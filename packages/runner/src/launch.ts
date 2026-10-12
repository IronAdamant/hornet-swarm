export function browserLaunchOptions(): { headless: boolean; executablePath?: string; args: string[] } {
  const executablePath = process.env.AEGIS_BROWSER ?? (process.env.AEGIS_BROWSER_USER ? process.env.AEGIS_BROWSER_LAUNCH : undefined);
  return {
    headless: process.env.AEGIS_HEADLESS === '1',
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
}
