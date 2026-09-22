import { Injectable } from '@nestjs/common';
import { createPublicClient, http, PublicClient } from 'viem';
import { SettingsService } from '../config/settings.service.js';

@Injectable()
export class RpcService {
  private readonly client: PublicClient;

  constructor(settings: SettingsService) {
    this.client = createPublicClient({ transport: http(settings.rpcUrl) });
  }

  getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }
}
