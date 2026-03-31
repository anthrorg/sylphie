// VITE_APP_MODE is set at build time; anything except 'production' enables dev features
const VITE_APP_MODE = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_APP_MODE

export function useDevMode(): boolean {
  return VITE_APP_MODE !== 'production'
}
