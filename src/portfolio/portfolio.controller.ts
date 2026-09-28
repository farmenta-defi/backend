import { Controller, Get, Param } from '@nestjs/common';
import { PortfolioService } from './portfolio.service.js';
@Controller('portfolio')
export class PortfolioController { constructor(private readonly portfolioService: PortfolioService) {} @Get(':address') get(@Param('address') address: string) { return this.portfolioService.portfolio(address); } }
