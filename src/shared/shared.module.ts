/**
 * SharedModule — global infrastructure module.
 *
 * @Global() makes this module's exports available to every other module in
 * the application without needing an explicit import. ConfigModule is the
 * only export — all other modules access configuration via ConfigService
 * without listing SharedModule in their own imports array.
 *
 * SharedModule is imported once, in AppModule. It must not be imported
 * anywhere else — @Global() ensures single-instance registration.
 *
 * Multiple config sections are loaded via registerAs() so subsystems can
 * retrieve typed config sections with: this.config.get<AppConfig>('app')
 * or this.config.get<WebConfig>('web')
 */

import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './config/app.config';
import { webConfig } from '../web/web.config';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, webConfig],
      envFilePath: '.env',
    }),
  ],
  exports: [ConfigModule],
})
export class SharedModule {}
