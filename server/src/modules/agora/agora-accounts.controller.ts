import { Body, ConflictException, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { SuperAdminGuard } from '../analytics/super-admin.guard';
import { AgoraAccountsService } from './agora-accounts.service';
import { AgoraUsageService } from './agora-usage.service';

@Controller('api/super/agora-accounts')
@UseGuards(SuperAdminGuard)
export class AgoraAccountsController {
  constructor(private readonly accounts: AgoraAccountsService, private readonly usage: AgoraUsageService) {}
  @Get()
  list() { return this.usage.list(); }
  @Post()
  async create(@Body() body: any) { return this.save(undefined, body); }
  @Put(':id')
  async save(@Param('id') id: string | undefined, @Body() body: any) {
    if (id && this.usage.isSyncing(id)) throw new ConflictException('校准中，请稍后保存');
    this.usage.flush();
    const account = await this.accounts.save(id, body);
    this.usage.attachExisting();
    return this.usage.list().find(a => a.id === account.id);
  }
  @Delete(':id')
  remove(@Param('id') id: string) {
    if (this.usage.isSyncing(id)) throw new ConflictException('校准中，请稍后删除');
    return this.accounts.remove(id);
  }
  @Post(':id/sync')
  async sync(@Param('id') id: string) { await this.usage.sync(id); return this.usage.list().find(a => a.id === id); }
}
