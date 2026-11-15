import { Global, Module } from '@nestjs/common';
import { AgoraService } from './agora.service';
import { AgoraAccountsService } from './agora-accounts.service';
import { AgoraUsageService } from './agora-usage.service';
import { AgoraAccountsController } from './agora-accounts.controller';

@Global()
@Module({
  providers: [AgoraService, AgoraAccountsService, AgoraUsageService],
  controllers: [AgoraAccountsController],
  exports: [AgoraService, AgoraAccountsService, AgoraUsageService],
})
export class AgoraModule {}
