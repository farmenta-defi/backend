export const marketAbi = [
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalBorrows',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'reserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'poolDebt',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'debtOf',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'oracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'interestRateModel',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'policy',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'valuer',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;
export const oracleAbi = [
  {
    type: 'function',
    name: 'priceForLiquidation',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint8' }],
  },
] as const;

export const rateModelAbi = [
  {
    type: 'function',
    name: 'ratePerSecond',
    stateMutability: 'view',
    inputs: [{ type: 'uint8' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;
export const lensAbi = [
  {
    type: 'function',
    name: 'positionValue',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'healthFactor',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'liquidationHealthFactor',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'liquidationCloseFactorBps',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint16' }],
  },
] as const;
export const valuerAbi = [
  {
    type: 'function',
    name: 'value',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { type: 'uint128' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
      },
    ],
  },
] as const;
export const policyAbi = [
  {
    type: 'function',
    name: 'listingOf',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { type: 'bool', name: 'listed' },
          { type: 'bool', name: 'frozen' },
          { type: 'uint8', name: 'tier' },
          { type: 'uint16', name: 'maxLtvBps' },
          { type: 'uint16', name: 'ltStartBps' },
          { type: 'uint16', name: 'ltTargetBps' },
          { type: 'uint40', name: 'rampStart' },
          { type: 'uint40', name: 'rampDuration' },
          { type: 'uint16', name: 'liquidatorBonusBps' },
          { type: 'uint16', name: 'removeHaircutBps' },
          { type: 'uint128', name: 'debtCapUsdg' },
          { type: 'uint128', name: 'minPositionUsd' },
        ],
      },
    ],
  },
] as const;
export const policyEffectiveLtAbi = [
  {
    type: 'function',
    name: 'effectiveLt',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint16' }],
  },
] as const;
