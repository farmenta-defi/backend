import { BadRequestException } from '@nestjs/common';

const MAX_LOG_INDEX = 2_147_483_647;

export function parseActivityCursor(cursor?: string | string[]) {
  if (cursor === undefined) return undefined;
  if (Array.isArray(cursor)) {
    throw new BadRequestException('cursor must be provided once');
  }
  const [blockNumber, logIndex, extra] = cursor.split(':');
  const parsedLogIndex = Number(logIndex);
  if (
    extra !== undefined ||
    !/^\d+$/.test(blockNumber ?? '') ||
    !/^\d+$/.test(logIndex ?? '') ||
    !Number.isSafeInteger(parsedLogIndex) ||
    parsedLogIndex > MAX_LOG_INDEX
  ) {
    throw new BadRequestException('cursor must be blockNumber:logIndex');
  }
  return { blockNumber, logIndex: parsedLogIndex };
}
