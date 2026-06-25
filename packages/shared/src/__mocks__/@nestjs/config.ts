/** Minimal @nestjs/config stub for unit tests in the shared package. */
export const registerAs = (token: string, factory: () => unknown) => factory;
export const ConfigModule = { forRoot: () => ({}) };
export class ConfigService {
  get<T>(key: string, defaultValue?: T): T | undefined {
    return defaultValue;
  }
}
